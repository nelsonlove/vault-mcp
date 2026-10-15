import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { SHARED_ANNOTATIONS, isVisible } from "@vault-mcp/core";
import type { ToolAnnotations, GuardSettings } from "@vault-mcp/core";
import { ok, okError, fail } from "./helpers.js";
import { jsonSchemaToZodShape, type JsonSchemaObject } from "./json-schema-to-zod.js";
import { collectPaths } from "../guard.js";
import type { ServerCtx } from "./tools-core.js";
import { KERNEL_ARG_KEYS, TOOL_DECLARATION, type ToolDeclaration, type DeclaredProtection, type DeclaredSync } from "../kernel/tool-declaration.js";

// ── Public boundary types (mirrored in the vault-mcp-api SDK — keep in sync) ──

export interface ExternalToolSpec {
  /** Bare tool name, /^[a-z][a-z0-9_]*$/; published as `${sanitizedOwnerId}_${name}`. */
  name: string;
  description: string;
  /** Plain JSON Schema only — zod instances must not cross the plugin boundary. */
  inputSchema?: JsonSchemaObject;
  /** Absent ⇒ treated as MUTATING (blocked in read-only mode). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  /** Called with the tool's arguments and, since apiVersion 2 (#402 step B), a
   *  per-call `CallContext` as the second argument. A handler may ignore it. */
  handler: (args: Record<string, unknown>, ctx?: CallContext) => Promise<unknown> | unknown;
  /** apiVersion 3 (#550): the write protection a call must carry, exactly as a
   *  host tool's inventory row states it. A class (`token` ⇒ `if_rev`, `key` ⇒
   *  `idempotency_key`, `both`, `exempt`) or argument-dependent. REQUIRED on a
   *  mutating tool that declares anything else of apiVersion 3. */
  protection?: ProtectionDeclaration;
  /** apiVersion 3 (#550): how the host's Sync guard treats the tool. */
  sync?: SyncDeclaration;
  /** apiVersion 3 (#550): the argument names that carry vault paths, each a
   *  key the host's path walk recognizes (`path`, `from`, `to`, `paths`,
   *  `note_path`, …). Under a path allowlist a call is then checked per path,
   *  and refused when no declared argument carries one. */
  paths?: string[];
}

/** One class of write protection (01.33 rule 6f). */
export type ProtectionClassDeclaration = "token" | "key" | "both" | "exempt";

/** A satellite tool's declared protection: a class, or a class chosen by one argument's value
 *  (booleans as "true"/"false"; `otherwise` covers every other value and the argument's absence). */
export type ProtectionDeclaration =
  | ProtectionClassDeclaration
  | { arg: string; values: Record<string, ProtectionClassDeclaration>; otherwise: ProtectionClassDeclaration };

/** A satellite tool's Sync-guard membership (the host's `syncKind`, `STATUS_STRICT` and destination-unnamed list). */
export interface SyncDeclaration {
  /** `structure` (rename, move, delete, create: waits, then refused while Sync is behind) or
   *  `content` (edit, append: waits, then goes on with a warning); or chosen by one argument's value. */
  kind:
    | "structure"
    | "content"
    | { arg: string; values: Record<string, "structure" | "content">; otherwise: "structure" | "content" };
  /** A rename, move or delete: also waits for "Fully synced" (the strict list). Structure only. */
  strictStatus?: boolean;
  /** The tool does not name where it writes: a server change waiting anywhere in the vault counts. Structure only. */
  destinationUnnamed?: boolean;
}

// ── apiVersion 2 members (#402 step B; the SDK carried them since 1.1.0) ─────
//
// The host may NOT import `vault-mcp-api` (tests/host-layering.test.mjs: it IS
// the host), so the brand, the predicate and the context type are re-spelled
// here and pinned against the SDK's by the SDK's contract test in both
// directions — the two spellings cannot drift.

/**
 * What every published handler receives per call (design §5). FUNCTIONS,
 * NEVER THE LIST: the allowlist is not handed over — a tool asks "may I show
 * this" and gets yes or no. Built per call from the LIVE settings (the
 * inert-toggle rule), never snapshotted at connection build.
 *
 * What it does NOT lift: F3 below still refuses a pathless external tool
 * wholesale under an active allowlist, because the host cannot verify a
 * satellite applied `visible`. The context re-lights the ROW filters of the
 * calls that get through, and is identity when no allowlist is active.
 */
export interface CallContext {
  /** The subset of `paths` this caller may see; the SAME array when no allowlist is active. */
  visible(paths: readonly string[]): readonly string[];
  /** One path. */
  isVisible(path: string): boolean;
  /** The session cannot write. */
  readOnly: boolean;
}

/** The context for one call, from the settings as they are NOW. Pure and
 *  exported so the identity convention and the live read are pinned. */
export function makeCallContext(settings: GuardSettings): CallContext {
  const active = settings.allowlist.length > 0;
  return {
    visible: (paths) => (active ? paths.filter((p) => isVisible(p, settings)) : paths),
    isVisible: (path) => isVisible(path, settings),
    readOnly: settings.readOnly === true,
  };
}

/** The partial-result envelope's brand (design §4): a string-keyed property
 *  because publisher and host are different bundles. Same spelling as the
 *  SDK's `PARTIAL_BRAND`, pinned by the SDK's contract test. */
export const PARTIAL_BRAND = "vault-mcp-api/envelope" as const;

export interface PartialEnvelope {
  [PARTIAL_BRAND]: "partial";
  data: Record<string, unknown>;
  message: string;
}

/** Whether a handler's TOP-LEVEL return value is a partial result. Exactly
 *  as strict as the SDK's `partial()` constructor and its `isPartial`: a plain
 *  object `data` (never an array — it goes into `structuredContent` verbatim)
 *  and a non-blank `message`. A partial nested inside data is data. */
export function isPartialEnvelope(value: unknown): value is PartialEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v[PARTIAL_BRAND] === "partial"
    && typeof v.message === "string" && v.message.trim() !== ""
    && !!v.data && typeof v.data === "object" && !Array.isArray(v.data);
}

/** The code a partial result carries in its first content line, in the
 *  `Error [code]: detail` shape the rest of the surface uses for typed
 *  outcomes (guarded.ts `codedError`, the batch decoder), so the operation
 *  executor maps it to the `partial` outcome — not to `refused`, which is
 *  what an uncoded `isError` means there — and the write journal's error
 *  text is the message, not the JSON. */
export const PARTIAL_CODE = "partial";

/** The wire shape of a partial result (design §4 rule 1): `structuredContent`
 *  is the data, `content` is the coded message line and then the JSON text,
 *  `isError` is set — the caller gets what was done AND the error bit, and
 *  every reader of `content[0]` (the executor's outcome, the journal's error
 *  text) sees the one sentence that says what failed. */
export function partialResult(env: PartialEnvelope) {
  const base = okError(env.data);
  return { ...base, content: [{ type: "text" as const, text: `Error [${PARTIAL_CODE}]: ${env.message}` }, ...base.content] };
}

export interface ExternalToolEntry {
  ownerId: string;   // raw plugin id as passed by the publisher
  toolName: string;  // namespaced published name
  spec: ExternalToolSpec;
  /** The spec's apiVersion-3 declaration, validated and frozen at registration;
   *  absent for a v2 spec. A later edit of the publisher's spec object changes nothing. */
  declaration?: ToolDeclaration;
}

/**
 * The tool-publishing half of `app.plugins.plugins['governor'].api`, mirrored
 * in the `vault-mcp-api` SDK and pinned against it by that package's
 * contract.test.ts. The api object the host exposes is this PLUS the governance
 * seam (mcp/seam.ts), which was additive and left `apiVersion` at 1. The number
 * became 2 at #402 step B for the partial-result envelope and the per-call
 * context; the SDK reads it as a FLOOR since 1.1.0, so a satellite rebuilt
 * against that SDK keeps registering.
 *
 * `unregisterTools(ownerPluginId)` USED TO LIVE HERE and was removed by S2 of
 * the suite split (condition 3, a correctness fix rather than armour): it was
 * ADDRESSED BY OWNER ID, so anyone holding the api object could revoke anyone
 * else's tools — one `unregisterTools('quickadd')` from a cleanup script and a
 * publisher's whole surface is gone, with nothing to tell it apart from a
 * publisher that never registered. The disposer `registerTools` returns is now
 * the ONLY revocation path, and it can revoke exactly what its holder
 * registered. The SDK never called the removed method (it has always used the
 * disposer, see vault-mcp-api's `publishTools`), so the contract it publishes
 * to third-party plugins is unchanged in practice.
 */
export interface VaultMcpApi {
  /** The level of members this host carries; a LITERAL on purpose (the SDK's
   *  contract test requires the host to declare one). 2 = the v1 surface plus
   *  the partial-result envelope and the per-call `CallContext`. 3 (#550) = 2
   *  plus the write declarations a spec may carry (`protection`, `sync`,
   *  `paths`), enforced exactly as for a host tool. */
  apiVersion: 3;
  registerTools(ownerPluginId: string, tools: ExternalToolSpec[]): () => void;
  /**
   * The operator's configured guarded territories, already resolved (trimmed,
   * blanks dropped). There is NO default (#397): a blank setting answers with
   * an EMPTY list, which means the operator guards nothing — honour it as-is.
   *
   * ADDITIVE, so it did not bump `apiVersion` when it landed (same reasoning
   * as the seam's methods): an older `vault-mcp-api` build that never calls
   * this keeps registering.
   *
   * WHY THE HOST PUBLISHES THIS AT ALL (#397). The list has consumers in both
   * plugins, and #396 first put the setting on Governor — which left this
   * plugin's observation capture, the one consumer that writes note bodies
   * OUTSIDE the vault, pinned to the compiled-in default. The owner has to be
   * the plugin that cannot be uninstalled, so the host holds the setting and
   * publishes it here. Read it live per call: an operator's edit must take
   * effect without either plugin reloading.
   *
   * OPTIONAL, and that is the contract rather than laziness: `vault-mcp-api`
   * builds already in the wild were compiled against a host without this, and a
   * REQUIRED method would make every one of them fail to satisfy the type — the
   * exact breakage an additive member promises not to cause. A caller must handle
   * its absence as "cannot tell" and FAIL CLOSED — never as "nothing is
   * guarded", and never by keeping a list of its own; `excludedUnderHost` in
   * packages/governor is the reference answer (absent ⇒ everything excluded).
   */
  guardedTerritories?(): readonly string[];
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function sanitizeOwnerId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * THE GRANDFATHER TABLE — the five governance tool names the provider publishes
 * BARE, unprefixed by its owner id (S3c).
 *
 * The publishing rule is `<sanitized owner id>_<bare name>`, and the whole
 * suite has paid that rename tax deliberately at every satellite extraction:
 * the plugin id IS the tool namespace, and a satellite's names change with it.
 * These cannot, because renaming a SHIPPED tool name breaks every agent session
 * for zero semantic gain — the locked decision that keeps `governance_revisions`
 * and `governance_submit_revision` spelled as they are. Under the split they
 * leave the host for the governance provider (§6 assigns them there), so without
 * this table `governance_revisions` would become
 * `governor_governance_revisions`.
 *
 * WHY A HOST-HELD TABLE AND NOT A FLAG ON THE SPEC. An `exactName: true` flag
 * would be publisher-controlled, so any plugin could claim any name. This table
 * is checked in, enumerable, and names the OWNER as well as the name, so only
 * `governor` can publish these five and nobody can publish anything else
 * unprefixed.
 *
 * ── IT CARVES OUT THE PREFIX RULE, AND NOTHING ELSE (Nelson, 2026-09-08) ─────
 *
 * The first draft of this table also held `obsidian_pending_review`, and
 * therefore also carved out F1 — the refusal of any published name beginning
 * `obsidian_`. **Nelson ruled against that and the tool was RENAMED instead**,
 * to `governance_pending_review`. Three reasons, and they bind anything that
 * comes here next:
 *
 *   1. An F1 exception, even one gated on a provider id, permanently weakens a
 *      NAMESPACE-INTEGRITY rule, and it becomes the precedent for the next
 *      exception. The rule is worth more than one name's continuity.
 *   2. The locked decision forbids renaming shipped tool names "for zero
 *      semantic gain", and this rename HAS semantic gain: the `obsidian_`
 *      prefix branded a governance tool as a host built-in, which after the
 *      split is an architectural lie. `governance_pending_review` says what the
 *      tool is and matches its two siblings.
 *   3. The breakage is near zero — MCP tools are discovered per session, and the
 *      one glob that patterns on the old spelling still matches.
 *
 * So F1 below is UNCONDITIONAL. No entry here may begin `obsidian_`, and there
 * is no branch that would let one through: a name in the reserved namespace is
 * refused whoever asks, which is what makes F1 a rule rather than a default.
 *
 * ── ONE ROW IS NOT CONTINUITY, AND SAYING SO IS THE POINT ───────────────────
 *
 * `governance_pending_review` was never on the wire under that spelling — it is
 * the RENAME the ruling above produced, and it is in this table because the
 * whole family has to be spelled consistently. Four bare `governance_*` names
 * beside one `governor_governance_pending_review` would recreate, in the tool
 * list an agent actually reads, exactly the incoherence the rename was meant to
 * remove. So the table's job is stated correctly as: these are the names the
 * governance provider publishes BARE. Continuity is why four of them are here;
 * family consistency is why the fifth is.
 *
 * IT IS CLOSED. Nothing is added here. A new tool takes the ordinary namespaced
 * form.
 */
export const GRANDFATHERED_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ["governance_pending_review", "governor"],
  ["governance_revisions", "governor"],
  ["governance_submit_revision", "governor"],
  ["governance_mandate_draft", "governor"],
  ["governance_mandates", "governor"],
]);

/**
 * The name a spec publishes under. Exported so the SDK contract test and the
 * provider's own publication test can assert the same answer this registry
 * computes.
 *
 * It decides the NAME only. Whether that name is legal is F1's question, asked
 * unconditionally at the call site — including of a grandfathered name, which
 * is why no entry above may begin `obsidian_`.
 */
export function publishedToolName(ownerPluginId: string, bareName: string): string {
  if (GRANDFATHERED_TOOL_NAMES.get(bareName) === ownerPluginId) return bareName;
  return `${sanitizeOwnerId(ownerPluginId)}_${bareName}`;
}

// ── apiVersion 3: the write declarations (#550) ──────────────────────────────

const PROTECTION_CLASSES: ReadonlySet<string> = new Set(["token", "key", "both", "exempt"]);
const SYNC_KINDS: ReadonlySet<string> = new Set(["structure", "content"]);

/** Whether the guard's path walk (core's collectPaths, the one every kernel check reads) treats `key` as a path key.
 *  Asked of the walk itself, so this cannot drift from it. */
function isPathKey(key: string): boolean {
  return collectPaths({ [key]: "probe" }).length > 0;
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validate a spec's apiVersion-3 declaration and return it normalized and
 * frozen, or undefined for a v2 spec (none of `protection`, `sync`, `paths`
 * present). FAIL CLOSED: anything malformed or contradictory throws a
 * TypeError naming the tool, so a typo can never register as a weaker tool.
 *
 * Refused: an unknown key in a declaration object (a misspelt `strictStatus`
 * would otherwise be silently off); a class or kind not in the closed set; an
 * argument (a path, or the one a protection or kind depends on) that the tool's
 * `inputSchema` does not declare (the host's validation would strip it, so the
 * rule would never see it) or that is a kernel argument; a path argument the
 * host's path walk does not recognize (the record guard, the lock consult, the
 * journal target, the Sync guard's targets and the allowlist all read paths by
 * that walk, so an unrecognized name would escape every one of them); the
 * strict or destination-unnamed list on a content-only tool; protection or
 * Sync declared on a tool that claims to be read-only; and a mutating tool
 * that declares `sync` or `paths` but no `protection`.
 */
export function validateDeclaration(spec: ExternalToolSpec): ToolDeclaration | undefined {
  const raw = spec as unknown as Record<string, unknown>;
  const has = (k: string) => raw[k] !== undefined;
  if (!has("protection") && !has("sync") && !has("paths")) return undefined;
  const bad = (why: string): never => {
    throw new TypeError(`vault-mcp: tool '${spec.name}' has a malformed apiVersion-3 declaration: ${why}`);
  };
  const props = plainObject(spec.inputSchema?.properties) ? (spec.inputSchema!.properties as Record<string, unknown>) : {};
  const argOk = (arg: unknown, what: string): string => {
    if (typeof arg !== "string" || arg === "") return bad(`${what} must be a non-empty string`);
    if ((KERNEL_ARG_KEYS as readonly string[]).includes(arg)) return bad(`${what} '${arg}' is a kernel argument`);
    if (!Object.prototype.hasOwnProperty.call(props, arg)) return bad(`${what} '${arg}' is not a property of the tool's inputSchema`);
    return arg;
  };
  const onlyKeys = (o: Record<string, unknown>, allowed: string[], what: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${what} has an unknown key '${k}' (allowed: ${allowed.join(", ")})`);
  };
  const byArg = <C extends string>(v: Record<string, unknown>, set: ReadonlySet<string>, what: string) => {
    onlyKeys(v, ["arg", "values", "otherwise"], what);
    const arg = argOk(v.arg, `${what}.arg`);
    if (!plainObject(v.values)) return bad(`${what}.values must be an object of value → class`);
    const values: Record<string, C> = {};
    for (const [k, c] of Object.entries(v.values)) {
      if (typeof c !== "string" || !set.has(c)) return bad(`${what}.values['${k}'] must be one of ${[...set].join(", ")}`);
      values[k] = c as C;
    }
    if (typeof v.otherwise !== "string" || !set.has(v.otherwise)) return bad(`${what}.otherwise must be one of ${[...set].join(", ")}`);
    return Object.freeze({ arg, values: Object.freeze(values), otherwise: v.otherwise as C });
  };

  const claimsReadOnly = spec.annotations?.readOnlyHint === true;
  const out: ToolDeclaration = {};

  if (has("protection")) {
    if (claimsReadOnly) bad("a tool that claims readOnlyHint cannot declare protection (a read carries no write protection)");
    const p = raw.protection;
    if (typeof p === "string") {
      if (!PROTECTION_CLASSES.has(p)) bad(`protection must be one of ${[...PROTECTION_CLASSES].join(", ")}, or { arg, values, otherwise }`);
      out.protection = p as DeclaredProtection;
    } else if (plainObject(p)) {
      out.protection = byArg<ProtectionClassDeclaration>(p, PROTECTION_CLASSES, "protection");
    } else {
      bad("protection must be a class string or { arg, values, otherwise }");
    }
  }

  if (has("sync")) {
    if (claimsReadOnly) bad("a tool that claims readOnlyHint cannot declare sync (the Sync guard checks writes)");
    const sy = raw.sync;
    if (!plainObject(sy)) return bad("sync must be { kind, strictStatus?, destinationUnnamed? }");
    onlyKeys(sy, ["kind", "strictStatus", "destinationUnnamed"], "sync");
    let kind: DeclaredSync["kind"];
    if (typeof sy.kind === "string") {
      if (!SYNC_KINDS.has(sy.kind)) bad("sync.kind must be structure, content, or { arg, values, otherwise }");
      kind = sy.kind as "structure" | "content";
    } else if (plainObject(sy.kind)) {
      kind = byArg<"structure" | "content">(sy.kind, SYNC_KINDS, "sync.kind");
    } else {
      return bad("sync.kind is required: structure, content, or { arg, values, otherwise }");
    }
    for (const f of ["strictStatus", "destinationUnnamed"] as const) {
      if (sy[f] !== undefined && typeof sy[f] !== "boolean") bad(`sync.${f} must be a boolean`);
    }
    const strictStatus = sy.strictStatus === true;
    const destinationUnnamed = sy.destinationUnnamed === true;
    if (kind === "content" && (strictStatus || destinationUnnamed)) {
      bad("sync.strictStatus and sync.destinationUnnamed apply to a structure write; this tool's kind is content");
    }
    out.sync = Object.freeze({ kind, strictStatus, destinationUnnamed });
  }

  if (has("paths")) {
    const ps = raw.paths;
    if (!Array.isArray(ps)) return bad("paths must be an array of argument names");
    const seen = new Set<string>();
    for (const a of ps) {
      const arg = argOk(a, "paths entry");
      if (!isPathKey(arg)) bad(`paths entry '${arg}' is not a path key the host recognizes (path, from, to, paths, note_path, …); the kernel's checks could not see it`);
      if (seen.has(arg)) bad(`paths entry '${arg}' is listed twice`);
      seen.add(arg);
    }
    out.paths = Object.freeze([...seen]);
  }

  if (!claimsReadOnly && out.protection === undefined) {
    bad("a mutating tool that declares sync or paths must also declare protection (token, key, both or exempt)");
  }
  return Object.freeze(out);
}

export class ExternalToolRegistry {
  private byName = new Map<string, ExternalToolEntry>();

  registerTools(ownerPluginId: string, tools: ExternalToolSpec[]): () => void {
    const owner = sanitizeOwnerId(ownerPluginId);
    if (!owner) throw new TypeError(`vault-mcp: unusable owner plugin id '${ownerPluginId}'`);
    // Validate everything before inserting anything — a mid-array failure
    // must not leave earlier specs registered with no disposer.
    const declarations = new Map<ExternalToolSpec, ToolDeclaration | undefined>();
    for (const spec of tools) {
      if (!NAME_RE.test(spec.name))
        throw new TypeError(`vault-mcp: invalid tool name '${spec.name}' (must match ${NAME_RE})`);
      if (typeof spec.handler !== "function")
        throw new TypeError(`vault-mcp: tool '${spec.name}' handler is not a function`);
      const toolName = publishedToolName(ownerPluginId, spec.name);
      // F1: reject names that collide with the built-in obsidian_* namespace.
      // UNCONDITIONAL — a grandfathered name is checked like any other. See the
      // table's header: the one name that would have needed an exception here
      // was renamed instead, on Nelson's ruling, because an exception to a
      // namespace-integrity rule is the precedent for the next exception.
      if (toolName.startsWith("obsidian_"))
        throw new TypeError(`vault-mcp: tool name '${toolName}' collides with the reserved obsidian_* namespace`);
      // F4: reject cross-owner clobbering (same-owner replace is by design).
      const existing = this.byName.get(toolName);
      if (existing && existing.ownerId !== ownerPluginId)
        throw new TypeError(`vault-mcp: tool '${toolName}' is already published by plugin '${existing.ownerId}'`);
      // F8: reject zod schemas and other non-JSON-Schema values.
      // (The apiVersion-3 declaration is validated after F8, below, because it reads the schema's properties.)
      if (spec.inputSchema !== undefined) {
        const s = spec.inputSchema as unknown;
        if (
          typeof s !== "object" || s === null ||
          (s as any).type !== "object" ||
          ((s as any).properties !== undefined &&
            (typeof (s as any).properties !== "object" ||
              Array.isArray((s as any).properties) ||
              (s as any).properties === null))
        ) {
          throw new TypeError(
            `vault-mcp: tool '${spec.name}' inputSchema must be a plain JSON Schema object ({ type: "object", … }) — zod schemas must be converted before crossing the plugin boundary (use the vault-mcp-api SDK)`
          );
        }
      }
      // F9 (apiVersion 3, #550): a malformed write declaration is refused here, fail closed.
      declarations.set(spec, validateDeclaration(spec));
    }
    const added: ExternalToolEntry[] = [];
    for (const spec of tools) {
      const declaration = declarations.get(spec);
      const entry: ExternalToolEntry = {
        ownerId: ownerPluginId,
        toolName: publishedToolName(ownerPluginId, spec.name),
        spec,
        ...(declaration ? { declaration } : {}),
      };
      this.byName.set(entry.toolName, entry); // replace-on-re-register, by design
      added.push(entry);
    }
    // THE ONLY REVOCATION PATH (S2, condition 3). The object-identity check
    // makes the disposer idempotent AND stops a stale disposer from deleting a
    // newer replacement registered under the same name — it revokes exactly the
    // entries THIS call inserted, and nothing else. There is deliberately no
    // id-addressed sibling: an address anyone can name is an address anyone can
    // forge, and the entries it would revoke belong to another plugin.
    return () => {
      for (const e of added) if (this.byName.get(e.toolName) === e) this.byName.delete(e.toolName);
    };
  }

  entries(): ExternalToolEntry[] {
    return Array.from(this.byName.values());
  }
}

// Called from buildMcpServer AFTER the guard monkeypatch, so external tools are
// guarded by read-only mode. Restrictive default: external tools are mutating
// unless they explicitly declare readOnlyHint: true (built-ins use the inverse
// convention — mutating iff readOnlyHint === false — which the guard keys on).
// When a path allowlist is configured, mutating tools whose args contain no
// recognized path field are blocked outright (allowlist bypass prevention).
//
// ── read-only claims are DISTRUSTED by default (MEDIUM-4) ───────────────────
//
// `readOnlyHint: true` on an external tool is an assertion by third-party code
// running in the same renderer, about code the host cannot inspect. Believing it
// buys the publisher an exemption from every kernel guarantee at once — no queue
// slot, no journal record, no allowlist scoping, no kernel arguments, and
// availability in read-only mode. That is the wrong thing to hand out on a
// publisher's say-so.
//
// So the claim is believed only for plugin ids the USER has listed in the
// `trustedReadOnlyPlugins` setting (empty by default). An untrusted read-only
// claim is treated as mutating: queued, journaled, allowlist-scoped, given the
// kernel arguments — and, in read-only mode, blocked outright by the guard,
// because "this tool doesn't write" is exactly the claim that mode exists to
// stop taking on trust.
//
// Trust is matched on the RAW publisher id, exactly, never on the sanitized
// tool-name form: two ids that sanitize alike must not inherit one another's
// trust. The setting is read at connection-build time, like the tool snapshot
// itself, so a trust change takes effect on the next session connect.

/**
 * The connection's external-tool snapshot, with the host's trust decision
 * already applied.
 *
 * Exported so the per-connection action registry and the registrar decide
 * "is this tool read-only" from ONE definition. Two copies of that rule would
 * be two chances to disagree, and the disagreement that matters is the registry
 * inventorying a tool as read-only while the guard treats it as mutating.
 *
 * `readOnly` here is the HOST's conclusion — the publisher claimed it AND the
 * user trusts that publisher — never the publisher's assertion alone.
 */
export function externalToolSnapshot(ctx: ServerCtx): Array<{ name: string; owner: string; readOnly: boolean }> {
  const trusted = new Set(ctx.getSettings().trustedReadOnlyPlugins ?? []);
  return (ctx.getExternalTools?.() ?? []).map(({ ownerId, toolName, spec }) => ({
    name: toolName,
    owner: ownerId,
    readOnly: spec.annotations?.readOnlyHint === true && trusted.has(ownerId),
  }));
}

export function registerExternalTools(server: McpServer, app: App, ctx: ServerCtx): void {
  const entries = ctx.getExternalTools?.() ?? [];
  const trusted = new Set(ctx.getSettings().trustedReadOnlyPlugins ?? []);
  for (const entry of entries) {
    const { ownerId, toolName, spec } = entry;
    // apiVersion 3 (#550): the validated declaration. An entry built by the
    // registry carries it; any other entry is validated here, and a malformed
    // one is skipped (fail closed) by the backstop below.
    let declaration: ToolDeclaration | undefined;
    try {
      declaration = entry.declaration ?? validateDeclaration(spec);
    } catch (e) {
      console.error("[vault-mcp] skipping external tool", toolName, e);
      continue;
    }
    // The publisher's claim, and whether this host believes it.
    const claimsReadOnly = spec.annotations?.readOnlyHint === true;
    const isReadOnly = claimsReadOnly && trusted.has(ownerId);
    if (claimsReadOnly && !isReadOnly) {
      console.info(
        `[vault-mcp] '${toolName}' declares readOnlyHint but '${ownerId}' is not in trustedReadOnlyPlugins; treating it as mutating`
      );
    }
    // F7: widen annotations passthrough — base from readOnlyHint, then overlay
    // explicit destructiveHint / idempotentHint when provided by the publisher.
    const base: ToolAnnotations = isReadOnly
      ? { ...SHARED_ANNOTATIONS.RO }
      : { ...SHARED_ANNOTATIONS.RW };
    if (spec.annotations?.destructiveHint !== undefined) base.destructiveHint = spec.annotations.destructiveHint;
    if (spec.annotations?.idempotentHint  !== undefined) base.idempotentHint  = spec.annotations.idempotentHint;
    const annotations = base;
    // The declaration rides on the definition, under a symbol the MCP wire never
    // sees, to the guard (mcp/guarded.ts), which enforces it as it enforces a host
    // tool's inventory row: protection before the queue, then the Sync guard. Only
    // on a tool this host treats as MUTATING: a trusted read-only tool never
    // reaches either check, and declaring protection on one is refused above.
    const declared = declaration && !isReadOnly ? { [TOOL_DECLARATION]: declaration } : {};

    // F6: snapshot the owner plugin instance at connection-build time.
    // Any change (reload or unload) detected at call time → stale-session error.
    const ownerAtBuild = (app as any).plugins?.plugins?.[ownerId];

    // Backstop: a bad entry must never break connection building.
    try {
      server.registerTool(
        toolName,
        {
          title: toolName,
          description: spec.description,
          inputSchema: jsonSchemaToZodShape(spec.inputSchema),
          annotations,
          ...declared,
        },
        async (args: Record<string, unknown>) => {
          // F6: require exact same plugin instance as at build time.
          // Covers both unload (undefined !== instance) and hot-reload (newObj !== instance).
          // Also catches entries whose owner was absent at build time (undefined identity).
          const currentOwner = (app as any).plugins?.plugins?.[ownerId];
          if (ownerAtBuild === undefined || currentOwner !== ownerAtBuild)
            return fail(new Error(`publisher plugin '${ownerId}' was reloaded or unloaded since this session connected; reconnect to use its tools`));
          // F3: when an allowlist is active, a tool that carries no recognized
          // path argument cannot be scoped — block it outright. This applies to
          // EVERY external tool, trusted or not (2026-09-05, found by the skills
          // satellite's review): trust (`trustedReadOnlyPlugins`) answers the
          // READ-ONLY-MODE question — "may this tool run in a session that
          // cannot write?" — and must not also answer the ALLOWLIST question,
          // because a trusted read-only tool that enumerates or returns vault
          // content with no path argument is exactly the read-boundary bypass
          // the allowlist sweep closed in-tree (`vaultmcp_skills_preview` returned
          // hidden note bodies; as a satellite tool under a trusted publisher it
          // would have again). A satellite cannot consult the host's allowlist,
          // so the host must refuse what it cannot scope. Fail closed; the cost
          // is that trusted pathless read tools are unavailable under an
          // allowlist, which is the documented posture, not a bug.
          //
          // apiVersion 3 (#550): a tool that declares `paths` is judged by THOSE
          // arguments. A call none of whose declared path arguments carries a path
          // is refused; one that does goes on, and the guard (which wraps this
          // handler) has already checked every path it names against the allowlist,
          // one by one, through the same guardCall/collectPaths a host tool meets.
          {
            const settings = ctx.getSettings();
            if (settings.allowlist.length > 0) {
              const a = (args ?? {}) as Record<string, unknown>;
              const named = declaration?.paths
                ? collectPaths(Object.fromEntries(declaration.paths.filter((k) => k in a).map((k) => [k, a[k]])))
                : collectPaths(a);
              if (named.length === 0)
                return fail(new Error(
                  declaration?.paths
                    ? `'${toolName}' is blocked: a path allowlist is configured but none of this tool's declared path arguments (${declaration.paths.join(", ") || "none"}) carries a path, so the call cannot be scoped. Name the path or clear the allowlist.`
                    : `'${toolName}' is blocked: a path allowlist is configured but this tool's arguments carry no recognized path field (path, from, to, paths, …), so the call cannot be scoped. Use recognized path argument names or clear the allowlist.`
                ));
            }
          }
          // F5: normalize handler return value to a plain object so ok() emits
          // valid structuredContent (undefined, primitives, and arrays all wrapped).
          try {
            // apiVersion 2: the per-call context, from the settings as they are
            // NOW (never captured at build), and the partial-result envelope,
            // checked on the top-level return value only.
            const r = await spec.handler(args ?? {}, makeCallContext(ctx.getSettings()));
            if (isPartialEnvelope(r)) return partialResult(r);
            const data =
              r === undefined                                          ? { ok: true } :
              (typeof r === "object" && r !== null && !Array.isArray(r)) ? r :
              { result: r };
            return ok(data);
          } catch (e) {
            return fail(e);
          }
        }
      );
    } catch (e) {
      console.error("[vault-mcp] skipping external tool", toolName, e);
    }
  }
}
