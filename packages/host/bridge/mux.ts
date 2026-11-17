// --- Multi-vault mode (`--multi-vault` / VAULT_MCP_MULTI) ---
//
// One MCP session, every open vault. The bridge keeps one ordinary
// BridgeRelay per vault (so reconnect, handshake replay, the grace queue and
// the preamble all stay per vault and unchanged) and puts this multiplexer
// between them and the real client. Each relay sees a "virtual client": a
// pair of in-process streams the mux writes into and reads from.
//
// What the client sees: one server whose tools each take an optional `vault`
// argument (an enum of the vaults that offer the tool). The mux strips it and
// routes the call; without it the call goes to the session's default vault
// (the #639 rules: --vault, then the session's directory, then
// --default-vault). The `initialize` result's `instructions` name the vaults
// and the default, so an agent knows the choice exists without probing.
//
// Routing, item by item:
//   initialize, tools/list       fan out to every live vault, merge the replies
//   tools/call                   to `arguments.vault`, else the default
//   notifications/cancelled      to the vault(s) that got the request
//   other notifications          to every live vault (initialized, roots, …)
//   other requests               to the default vault (ping, resources, …)
//   batches                      refused (no MCP client sends them)
// Server-to-client requests get their ids rewritten per vault, since two
// vaults may pick the same id; the client's reply is mapped back.
//
// The vault set is fixed when the session starts: a vault opened later needs
// a new session. A vault that goes away is reported as unavailable on calls.

import { splitLines } from "../src/ndjson.js";

type Id = string | number;

interface Msg {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

export const VAULT_ARG = "vault";

/** One vault as the mux sees it: lines in, lines out. */
export interface MuxBackend {
  name: string;
  /** Lines to the vault (the relay's virtual client input). */
  input: NodeJS.WritableStream;
  /** Lines from the vault (the relay's virtual client output). */
  output: NodeJS.ReadableStream;
  /** The vault's folder, for the instructions text. */
  path?: string;
}

export interface MuxIO {
  clientIn: NodeJS.ReadableStream;
  clientOut: NodeJS.WritableStream;
  log?: (msg: string) => void;
}

export interface MuxOpts {
  /** The vault a call without `vault` goes to; undefined means the call must name one. */
  defaultVault?: string;
  /** Why that vault is the default, for the instructions text. */
  defaultReason?: string;
  /**
   * A `--vault` pin whose vault is not open. Calls without `vault` are then
   * refused with a message naming it, never sent to another vault (#643).
   */
  missingPin?: string;
  /** How long a fan-out waits for slow vaults before answering with the rest (ms). */
  fanoutTimeoutMs?: number;
}

// --- Pure helpers (exported for tests) ---

/** The `vault` argument's schema for one tool. */
export function vaultProperty(offeredBy: string[], defaultVault: string | undefined): Record<string, unknown> {
  const dflt = defaultVault !== undefined && offeredBy.includes(defaultVault)
    ? ` Default: "${defaultVault}".`
    : " No default for this session: name one.";
  return {
    type: "string",
    enum: offeredBy,
    description: `Which vault to run this on: ${offeredBy.map((v) => `"${v}"`).join(", ")}.${dflt}`,
  };
}

/** A copy of a tool's inputSchema with the `vault` argument added (never required). */
export function withVaultArg(
  schema: unknown,
  offeredBy: string[],
  defaultVault: string | undefined
): Record<string, unknown> {
  const base = schema !== null && typeof schema === "object" ? (schema as Record<string, unknown>) : { type: "object" };
  const props = base.properties !== null && typeof base.properties === "object"
    ? (base.properties as Record<string, unknown>)
    : {};
  if (VAULT_ARG in props) {
    throw new Error(`a tool already declares a "${VAULT_ARG}" argument; multi-vault mode cannot add its own`);
  }
  return { ...base, properties: { ...props, [VAULT_ARG]: vaultProperty(offeredBy, defaultVault) } };
}

/**
 * Merge per-vault `tools/list` results into one list. A tool's definition is
 * taken from the default vault when it has it, else from the first vault (in
 * `order`) that does; its `vault` enum lists every vault that offers it.
 */
export function mergeToolLists(
  results: Map<string, Record<string, unknown>>,
  order: string[],
  defaultVault: string | undefined
): { tools: Record<string, unknown>[] } {
  const offered = new Map<string, string[]>();
  const defs = new Map<string, Record<string, unknown>>();
  const vaults = defaultVault !== undefined && order.includes(defaultVault)
    ? [defaultVault, ...order.filter((v) => v !== defaultVault)]
    : order;
  for (const v of vaults) {
    const res = results.get(v);
    if (!res) continue;
    if (res.nextCursor !== undefined && res.nextCursor !== null) {
      throw new Error(`vault "${v}" paginated tools/list; multi-vault mode does not page`);
    }
    for (const t of (Array.isArray(res.tools) ? res.tools : []) as Record<string, unknown>[]) {
      const name = String(t.name);
      if (!defs.has(name)) defs.set(name, t);
      offered.set(name, [...(offered.get(name) ?? []), v]);
    }
  }
  const tools: Record<string, unknown>[] = [];
  for (const [name, def] of defs) {
    const by = order.filter((v) => offered.get(name)!.includes(v));
    tools.push({ ...def, inputSchema: withVaultArg(def.inputSchema, by, defaultVault) });
  }
  return { tools };
}

/** The text added to the `initialize` result's instructions. */
export function muxInstructions(
  backends: { name: string; path?: string }[],
  defaultVault: string | undefined,
  defaultReason?: string,
  missingPin?: string
): string {
  const list = backends.map((b) => `"${b.name}"${b.path ? ` (${b.path})` : ""}`).join(", ");
  const dflt = defaultVault !== undefined
    ? `Without it, tools act on "${defaultVault}"${defaultReason ? ` (${defaultReason})` : ""}.`
    : missingPin !== undefined
      ? `This session is pinned to vault "${missingPin}" (--vault), which is not open: every tool call must name an open vault.`
      : "This session has no default vault: every tool call must name one.";
  return (
    `This server spans ${backends.length} Obsidian vaults: ${list}. ` +
    `Every tool takes an optional "${VAULT_ARG}" argument naming the vault to act on. ${dflt}`
  );
}

/** Merge per-vault `initialize` results: the default's (else the first's), capabilities unioned, instructions extended. */
export function mergeInitialize(
  results: Map<string, Record<string, unknown>>,
  order: string[],
  defaultVault: string | undefined,
  note: string
): Record<string, unknown> {
  const first = (defaultVault !== undefined && results.has(defaultVault) ? defaultVault : order.find((v) => results.has(v)))!;
  const base = results.get(first)!;
  const caps: Record<string, unknown> = {};
  for (const v of order) {
    const c = results.get(v)?.capabilities;
    if (c !== null && typeof c === "object") {
      for (const [k, val] of Object.entries(c as Record<string, unknown>)) {
        caps[k] = caps[k] !== undefined && typeof caps[k] === "object" && typeof val === "object"
          ? { ...(caps[k] as object), ...(val as object) }
          : (caps[k] ?? val);
      }
    }
  }
  const prior = typeof base.instructions === "string" && base.instructions !== "" ? `${base.instructions}\n\n` : "";
  return { ...base, capabilities: caps, instructions: `${prior}${note}` };
}

function toolError(id: Id, text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
}

function rpcError(id: Id | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

const SERVER_ID_PREFIX = "vault-mcp-mux:";

// --- The multiplexer ---

interface FanOut {
  method: string;
  waiting: Set<string>;
  results: Map<string, Record<string, unknown>>;
  errors: Map<string, unknown>;
  timer: NodeJS.Timeout | null;
}

export class VaultMux {
  private readonly backends = new Map<string, MuxBackend>();
  private readonly order: string[];
  private readonly dead = new Set<string>();
  private readonly routed = new Map<Id, string>();
  private readonly fanouts = new Map<Id, FanOut>();
  private readonly serverIds = new Map<string, { vault: string; id: Id }>();
  private serverSeq = 0;
  private inBuf = "";
  private readonly defaultVault: string | undefined;
  private readonly defaultReason: string | undefined;
  private readonly missingPin: string | undefined;
  private readonly fanoutTimeoutMs: number;

  constructor(private io: MuxIO, backends: MuxBackend[], opts: MuxOpts = {}) {
    for (const b of backends) {
      if (this.backends.has(b.name)) throw new Error(`two open vaults are both named "${b.name}"; rename one`);
      this.backends.set(b.name, b);
    }
    this.order = backends.map((b) => b.name);
    this.defaultVault = opts.defaultVault !== undefined && this.backends.has(opts.defaultVault) ? opts.defaultVault : undefined;
    this.defaultReason = opts.defaultReason;
    this.missingPin = this.defaultVault === undefined ? opts.missingPin : undefined;
    this.fanoutTimeoutMs = opts.fanoutTimeoutMs ?? 15000;
  }

  start(): void {
    this.io.clientIn.setEncoding("utf8");
    this.io.clientIn.on("data", (chunk: string | Buffer) => this.onClientData(String(chunk)));
    this.io.clientIn.on("end", () => {
      if (this.inBuf.length > 0) this.onClientData("\n");
      for (const b of this.backends.values()) b.input.end();
    });
    for (const b of this.backends.values()) {
      let buf = "";
      b.output.setEncoding("utf8");
      b.output.on("data", (chunk: string | Buffer) => {
        const { lines, rest } = splitLines(buf, String(chunk));
        buf = rest;
        for (const line of lines) this.onVaultLine(b.name, line);
      });
    }
  }

  /** The vault's relay gave up (or the session ended): stop routing to it. */
  markDead(name: string): void {
    if (this.dead.has(name)) return;
    this.dead.add(name);
    for (const [id, f] of this.fanouts) {
      if (f.waiting.delete(name) && f.waiting.size === 0) this.finishFanout(id);
    }
  }

  liveCount(): number {
    return this.order.filter((v) => !this.dead.has(v)).length;
  }

  private live(): string[] {
    return this.order.filter((v) => !this.dead.has(v));
  }

  private send(vault: string, msg: Msg | string): void {
    const line = typeof msg === "string" ? msg : JSON.stringify(msg);
    this.backends.get(vault)!.input.write(`${line}\n`);
  }

  private reply(line: string): void {
    this.io.clientOut.write(`${line}\n`);
  }

  // --- client → vaults ---

  private onClientData(chunk: string): void {
    const { lines, rest } = splitLines(this.inBuf, chunk);
    this.inBuf = rest;
    for (const line of lines) this.onClientLine(line);
  }

  private onClientLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.reply(rpcError(null, -32700, "vault-mcp: parse error"));
      return;
    }
    if (Array.isArray(msg)) {
      this.reply(rpcError(null, -32600, "vault-mcp: batches are not supported in multi-vault mode"));
      return;
    }
    if (msg === null || typeof msg !== "object") {
      this.reply(rpcError(null, -32600, "vault-mcp: invalid request"));
      return;
    }
    const m = msg as Msg;
    const id = m.id === null ? undefined : m.id;

    // A reply to a server-initiated request: map the id back to its vault.
    if (m.method === undefined) {
      const back = typeof id === "string" ? this.serverIds.get(id) : undefined;
      if (!back) {
        this.io.log?.(`dropping a client reply to an unknown request id ${JSON.stringify(id)}`);
        return;
      }
      this.serverIds.delete(id as string);
      if (!this.dead.has(back.vault)) this.send(back.vault, { ...m, id: back.id });
      return;
    }

    // Notifications.
    if (id === undefined) {
      if (m.method === "notifications/cancelled") {
        const rid = (m.params as { requestId?: Id } | undefined)?.requestId;
        const to = rid === undefined ? undefined : this.routed.get(rid);
        const targets = to !== undefined ? [to] : rid !== undefined && this.fanouts.has(rid) ? [...this.fanouts.get(rid)!.waiting] : [];
        for (const v of targets) if (!this.dead.has(v)) this.send(v, line);
        return;
      }
      for (const v of this.live()) this.send(v, line);
      return;
    }

    // Requests.
    if (m.method === "initialize" || m.method === "tools/list") {
      this.fanOut(id, m.method, line);
      return;
    }
    if (m.method === "tools/call") {
      this.routeCall(id, m, line);
      return;
    }
    const to = this.defaultVault ?? this.live()[0];
    if (to === undefined || this.dead.has(to)) {
      this.reply(rpcError(id, -32000, `vault-mcp: no vault available for ${m.method}`));
      return;
    }
    this.routed.set(id, to);
    this.send(to, line);
  }

  private routeCall(id: Id, m: Msg, line: string): void {
    const params = (m.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
    const args = params.arguments;
    const asked = args && typeof args === "object" ? args[VAULT_ARG] : undefined;
    const names = this.order.map((v) => `"${v}"`).join(", ");
    let to: string | undefined;
    if (asked !== undefined) {
      if (typeof asked !== "string" || !this.backends.has(asked)) {
        this.reply(toolError(id, `vault-mcp: no open vault named ${JSON.stringify(asked)}; choose one of ${names}.`));
        return;
      }
      to = asked;
    } else if (this.defaultVault !== undefined) {
      to = this.defaultVault;
    } else if (this.missingPin !== undefined) {
      this.reply(toolError(id, `vault-mcp: this session is pinned to vault ${JSON.stringify(this.missingPin)} (--vault), which is not open; open it and start a new session, or pass "${VAULT_ARG}" as one of ${names}.`));
      return;
    } else {
      this.reply(toolError(id, `vault-mcp: this session has no default vault; pass "${VAULT_ARG}" as one of ${names}.`));
      return;
    }
    if (this.dead.has(to)) {
      this.reply(toolError(id, `vault-mcp: vault "${to}" is no longer reachable in this session; open it in Obsidian and start a new session.`));
      return;
    }
    this.routed.set(id, to);
    if (asked === undefined) {
      this.send(to, line);
      return;
    }
    const { [VAULT_ARG]: _drop, ...rest } = args!;
    this.send(to, { ...m, params: { ...params, arguments: rest } });
  }

  private fanOut(id: Id, method: string, line: string): void {
    const targets = this.live();
    if (targets.length === 0) {
      this.reply(rpcError(id, -32000, `vault-mcp: no vault available for ${method}`));
      return;
    }
    const f: FanOut = { method, waiting: new Set(targets), results: new Map(), errors: new Map(), timer: null };
    this.fanouts.set(id, f);
    f.timer = setTimeout(() => {
      f.timer = null;
      if (f.waiting.size > 0) this.io.log?.(`${method}: no answer from ${[...f.waiting].join(", ")}; answering without them`);
      this.finishFanout(id);
    }, this.fanoutTimeoutMs);
    (f.timer as { unref?: () => void }).unref?.();
    for (const v of targets) this.send(v, line);
  }

  private finishFanout(id: Id): void {
    const f = this.fanouts.get(id);
    if (!f) return;
    this.fanouts.delete(id);
    if (f.timer) clearTimeout(f.timer);
    if (f.results.size === 0) {
      const err = [...f.errors.values()][0];
      this.reply(err !== undefined
        ? JSON.stringify({ jsonrpc: "2.0", id, error: err })
        : rpcError(id, -32000, `vault-mcp: no vault answered ${f.method}`));
      return;
    }
    try {
      const result = f.method === "initialize"
        ? mergeInitialize(f.results, this.order, this.defaultVault,
            muxInstructions(this.order.map((v) => ({ name: v, path: this.backends.get(v)!.path })), this.defaultVault, this.defaultReason, this.missingPin))
        : mergeToolLists(f.results, this.order, this.defaultVault);
      this.reply(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (e) {
      this.reply(rpcError(id, -32603, `vault-mcp: ${(e as Error).message}`));
    }
  }

  // --- vaults → client ---

  private onVaultLine(vault: string, line: string): void {
    let m: Msg;
    try {
      m = JSON.parse(line) as Msg;
    } catch {
      this.reply(line);
      return;
    }
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      this.reply(line);
      return;
    }
    const id = m.id === null ? undefined : m.id;
    if (m.method !== undefined) {
      // A server-initiated request: give it an id no other vault can collide with.
      if (id !== undefined) {
        const muxId = `${SERVER_ID_PREFIX}${++this.serverSeq}`;
        this.serverIds.set(muxId, { vault, id });
        this.reply(JSON.stringify({ ...m, id: muxId }));
        return;
      }
      this.reply(line);
      return;
    }
    if (id === undefined) {
      this.reply(line);
      return;
    }
    const f = this.fanouts.get(id);
    if (f && f.waiting.has(vault)) {
      f.waiting.delete(vault);
      if (m.error !== undefined) f.errors.set(vault, m.error);
      else if (m.result && typeof m.result === "object") f.results.set(vault, m.result);
      if (f.waiting.size === 0) this.finishFanout(id);
      return;
    }
    if (this.routed.get(id) === vault) {
      this.routed.delete(id);
      this.reply(line);
      return;
    }
    // A late answer to a fan-out already answered, or a stray: the client has its reply.
  }
}
