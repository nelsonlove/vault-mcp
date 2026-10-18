// src/index.ts
import type { Plugin } from "obsidian";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ── Boundary types (mirror packages/host/src/mcp/external-tools.ts) ────────

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface ExternalToolSpec {
  name: string;
  description: string;
  inputSchema?: JsonSchemaObject;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  /** The host calls this with the tool's arguments and, from apiVersion 2, a
   *  per-call `CallContext` as the SECOND argument; a v1 host passes nothing
   *  there. A handler written against this SDK may ignore it. */
  handler: (args: Record<string, unknown>, ctx?: CallContext) => Promise<unknown> | unknown;
  /** apiVersion 3: the write protection a call must carry. See `ProtectionDeclaration`. */
  protection?: ProtectionDeclaration;
  /** apiVersion 3: how the host's Sync guard treats the tool. See `SyncDeclaration`. */
  sync?: SyncDeclaration;
  /** apiVersion 3: the argument names that carry vault paths. */
  paths?: string[];
}

// ── apiVersion 3 members: the write declarations (#550) ──────────────────────
//
// A host tool states its write protection and its Sync-guard membership in the
// host's own tables, keyed by tool name. A published tool has no row there, so
// through apiVersion 2 the host checked none of it. From apiVersion 3 a spec
// declares them, and the host enforces them exactly as for one of its own
// tools. A spec that declares none of the three is an apiVersion-2 spec and
// behaves as before. The host refuses a malformed declaration at registration
// (fail closed): an unknown key, a class outside the closed set, an argument
// the tool's inputSchema does not declare, a path argument the host's path walk
// does not recognize, the Sync lists on a content-only tool, protection or sync
// on a tool that claims to be read-only, and a mutating tool that declares sync
// or paths but no protection.

/** The level of host members a spec carrying `protection`, `sync` or `paths` needs. */
export const API_VERSION_DECLARATIONS = 3;

/** One class of write protection (01.33 rule 6f): `token` ⇒ the call must carry
 *  `if_rev`, `key` ⇒ `idempotency_key`, `both`, or `exempt` (nothing required). */
export type ProtectionClassDeclaration = "token" | "key" | "both" | "exempt";

/** A tool's declared protection: a class, or a class chosen by one argument's
 *  value (booleans as "true"/"false"; `otherwise` covers every other value and
 *  the argument's absence). A call that omits what its class requires is
 *  refused `Error [protection_required]` before it runs. */
export type ProtectionDeclaration =
  | ProtectionClassDeclaration
  | { arg: string; values: Record<string, ProtectionClassDeclaration>; otherwise: ProtectionClassDeclaration };

/** A tool's place in the host's Sync guard (Obsidian Sync checked before a write). */
export interface SyncDeclaration {
  /** `structure` (rename, move, delete, create: waits for Sync, then refused
   *  `sync_behind` if Sync is still behind) or `content` (edit, append: waits,
   *  then goes on with a warning); or chosen by one argument's value. */
  kind:
    | "structure"
    | "content"
    | { arg: string; values: Record<string, "structure" | "content">; otherwise: "structure" | "content" };
  /** The strict list: a rename, move or delete, which also waits (up to `strictWaitSeconds`) for "Fully synced" or Sync's idle flags. Structure only. */
  strictStatus?: boolean;
  /** The destination-unnamed list: the tool does not name where it writes, so a
   *  server change waiting anywhere in the vault counts. Structure only. */
  destinationUnnamed?: boolean;
}

/** Whether a spec carries any apiVersion-3 declaration. */
export function declaresWrites(spec: { protection?: unknown; sync?: unknown; paths?: unknown }): boolean {
  return spec.protection !== undefined || spec.sync !== undefined || spec.paths !== undefined;
}

// ── apiVersion 2 members, in the SDK ahead of the host (#402 step A) ─────────
//
// THE VERSION NUMBER IS A FLOOR. This SDK used to refuse any host whose
// `apiVersion` was not exactly 1, so the day the host said 2 every satellite
// built against the SDK would have gone dark at once, silently but for a
// console line. Ruled 2026-09-26 (#402 design, Decisions): the SDK accepts
// `apiVersion >= API_VERSION_MIN`, and a member is detected by PRESENCE, never
// by the number — the number says "this host has at least these members".
// Step A ships the members below in the SDK while the host still says 1; the
// satellites rebuild (no code change); then the host bumps (step B).

/** The lowest host apiVersion this SDK registers against. */
export const API_VERSION_MIN = 1;

/**
 * Per-call context a v2 host hands every published handler as its second
 * argument (design §5). FUNCTIONS, NEVER THE LIST: the host's allowlist is not
 * handed over — a tool asks "may I show this" and gets yes or no.
 *
 * Absent (a v1 host, or a call made before step B lands) means "cannot tell":
 * a handler that filters must keep whatever it does today, never read absence
 * as "everything is visible".
 *
 * What it does NOT lift: a pathless external tool under an active allowlist is
 * still refused wholesale by the host (the host cannot verify a satellite
 * applied `visible`); the context re-lights the ROW filters of tools whose
 * calls get through, not that gate.
 */
export interface CallContext {
  /** The subset of `paths` this caller may see. Returns the SAME array when no
   *  allowlist is active (the host's own identity convention). */
  visible(paths: readonly string[]): readonly string[];
  /** One path. */
  isVisible(path: string): boolean;
  /** The session cannot write. A mutating tool called here was already refused
   *  by the host; this is for tools that branch. */
  readOnly: boolean;
}

/** The brand a partial result carries on the wire — a string-keyed property,
 *  not a class or a Symbol, because publisher and host are different bundles
 *  and `instanceof` does not cross them. */
export const PARTIAL_BRAND = "vault-mcp-api/envelope" as const;

/** What `partial()` returns and a v2 host detects (design §4): the data the
 *  tool could produce plus the message saying what it could not. A v2 host
 *  puts `data` in `structuredContent`, the JSON and the message in `content`,
 *  and sets `isError: true`; a thrown error stays text-only, as today. */
export interface PartialResult<T extends object> {
  [PARTIAL_BRAND]: "partial";
  data: T;
  message: string;
}

/**
 * Return a partial result from a handler: `data` reached the caller AND the
 * error bit is set, so an agent sees both what was done and what was not.
 *
 * On a v1 host the branded object is wrapped as an ordinary `ok(data)` with
 * the brand key visible — degraded, not broken. A publisher that needs the
 * error bit checks `api.apiVersion >= 2` before relying on it (or simply
 * accepts the degraded shape on old hosts).
 */
export function partial<T extends object>(data: T, message: string): PartialResult<T> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("partial(): data must be a plain object (the structured half of the result)");
  }
  if (typeof message !== "string" || message.trim() === "") {
    throw new TypeError("partial(): message must say what the tool could not do");
  }
  return { [PARTIAL_BRAND]: "partial", data, message };
}

/** Whether a handler's TOP-LEVEL return value is a partial result. The brand
 *  is checked only there (design §4 rule 2): a `partial` nested inside `data`
 *  is data. The recognizer is exactly as strict as the constructor — a plain
 *  object `data` (never an array: the host puts `data` in `structuredContent`
 *  verbatim, and an array there is what its own normalisation avoids) and a
 *  non-blank `message` — so a hand-built envelope the constructor would refuse
 *  is not partial either.
 *
 *  Exported for publishers' own tests and for the contract test. The HOST may
 *  not import this package (its layering rule: it IS the host, it does not
 *  depend on the publishing SDK), so at step B the host re-spells the brand
 *  and this predicate on its own side, pinned against these by the contract
 *  test so the two cannot drift. */
export function isPartial(value: unknown): value is PartialResult<object> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v[PARTIAL_BRAND] === "partial"
    && typeof v.message === "string" && v.message.trim() !== ""
    && !!v.data && typeof v.data === "object" && !Array.isArray(v.data);
}

/**
 * The host's tool-publishing api, mirrored from
 * packages/host/src/mcp/external-tools.ts and pinned against it by
 * tests/contract.test.ts.
 *
 * `unregisterTools(ownerPluginId)` was REMOVED from both sides by S2 of the
 * suite split: it was addressed by owner id, so any caller holding the api
 * object could revoke any publisher's tools. The disposer `registerTools`
 * returns is now the only revocation path — which is what `publishTools` below
 * has always used, so nothing in this SDK changes behaviour. `apiVersion` stays
 * 1: the host removed a method it never needed to offer and added the
 * governance seam beside it, and neither changes what a publisher sends.
 */
export interface VaultMcpApi {
  /** A FLOOR, not an exact match (#402 step A): the host declares the version
   *  whose members it carries, and this SDK registers against any host at or
   *  above `API_VERSION_MIN`. Members are detected by presence. */
  apiVersion: number;
  registerTools(ownerPluginId: string, tools: ExternalToolSpec[]): () => void;
  /**
   * The host operator's configured guarded territories — vault areas no plugin
   * should retain a copy of outside the vault — already resolved (trimmed,
   * blanks dropped). The host ships NO default list: an empty answer means the
   * operator guards nothing, and that is their call. Do not keep a list of your
   * own; the host's is the only one.
   *
   * OPTIONAL on purpose. `apiVersion` stays 1 because this is additive, and it
   * can only stay additive if a publisher compiled against an older host still
   * satisfies the type. Treat its ABSENCE as "cannot tell" and FAIL CLOSED
   * (retain nothing, govern nothing) until a host that answers is present —
   * never as "there are no guarded territories", which would read an old host
   * as permission to retain anything.
   */
  guardedTerritories?(): readonly string[];
}

// ── The governance seam (mirrors packages/host/src/mcp/seam.ts) ───────────────
//
// The host's hook API for an OPTIONAL governance provider. It ships on the same
// `plugin.api` object `registerTools` does — `apiVersion` stays 1 because the
// methods are additive, and a bump would make every published build of this SDK
// refuse to register.
//
// TWO HOOK CLASSES, AND THERE WILL NEVER BE A THIRD. `registerWriteObserver` is
// post-write and observe-only (the host ignores the return value);
// `registerSessionRefusal` is consulted at dequeue and returns `{code, detail}`
// or `null`. `null` is SILENCE, not an allow — the type cannot express
// permission, so a registrant can never un-refuse what the host or another
// registrant refused. Anything that could mutate a write in flight or assert
// acceptance is the class the seam must never offer.
//
// REVOCATION IS THE DISPOSER AND ONLY THE DISPOSER. `id` is a diagnostic label
// and an owner name; it addresses nothing (an address anyone can name is an
// address anyone can forge — the defect that removed `unregisterTools`).

/**
 * The journal's attribution for an operation, verbatim. Mirrored from the
 * host's `JournalActor` and pinned against it by tests/contract.test.ts.
 */
export interface JournalActor {
  transport: string;
  client?: string;
  connection: string;
  session?: string;
  server?: { vault: string; install: string; version: string };
}

/**
 * The exact facts of a COMPLETED write, as the host observed them.
 * `baseBytes: null` means creation.
 *
 * The byte arrays are the host's own buffers, handed over without a per-hook
 * copy; `operation` and `actor` are deep-frozen by the host before dispatch.
 * Nothing here is a capability: no callback, no store handle, no app reference.
 */
export interface WriteFacts {
  path: string;
  baseBytes: Uint8Array | null;
  proposedBytes: Uint8Array;
  operation: { id: string; action: string; actionVersion: number; sessionId: string | null };
  actor: JournalActor;
}

/** A typed refusal, rendered by the host as `Error [code]: detail`. */
export interface SeamRefusal {
  code: string;
  detail: string;
}

export type WriteObserver = (facts: WriteFacts) => void | Promise<void>;
export type SessionRefusalHook = (
  sessionId: string | null,
) => SeamRefusal | null | Promise<SeamRefusal | null>;

/** The registration half of the seam, as it appears on the host's api object. */
export interface GovernanceSeam {
  registerWriteObserver(id: string, observe: WriteObserver): () => void;
  registerSessionRefusal(id: string, refuse: SessionRefusalHook): () => void;
}

export interface GovernanceHooks {
  /** Post-write, observe-only. Throwing or hanging costs the caller nothing. */
  writeObserver?: WriteObserver;
  /** Consulted at dequeue. A refusal aborts the mutation; a throw IS a refusal. */
  sessionRefusal?: SessionRefusalHook;
}

// ── Publisher-facing spec ─────────────────────────────────────────────────────

export interface SdkToolSpec {
  /** Bare name, /^[a-z][a-z0-9_]*$/; published as `<your-plugin-id>_<name>`. */
  name: string;
  description: string;
  /** A zod raw shape ({ path: z.string() }) or a plain JSON Schema object. */
  inputSchema?: Record<string, z.ZodTypeAny> | JsonSchemaObject;
  /** Omitted or false ⇒ the tool counts as MUTATING (blocked by the host's read-only mode). */
  readOnly?: boolean;
  /** Set true if the tool can destroy user data (delete/overwrite); advisory hint surfaced to MCP clients. */
  destructive?: boolean;
  /** Set true if repeated identical calls have no additional effect. */
  idempotent?: boolean;
  /** Called with the tool's arguments and, from a v2 host, a per-call
   *  `CallContext` (see its doc for what absence means). May return a
   *  `partial(...)` to set the error bit while still returning data. */
  handler: (args: Record<string, unknown>, ctx?: CallContext) => Promise<unknown> | unknown;
  /** apiVersion 3: the protection a call must carry (`if_rev`, `idempotency_key`).
   *  Required on a mutating tool that declares `sync` or `paths`. */
  protection?: ProtectionDeclaration;
  /** apiVersion 3: the tool's place in the host's Sync guard. */
  sync?: SyncDeclaration;
  /** apiVersion 3: the argument names that carry vault paths, each a key the
   *  host's path walk recognizes (`path`, `from`, `to`, `paths`, `note_path`, …).
   *  Under a path allowlist each call is checked per path, and refused when no
   *  declared argument carries one. */
  paths?: string[];
}

/**
 * The host plugin's id, CURRENT FIRST. The id has moved twice: `vault-mcp` →
 * `governor` at 0.12.0, and `governor` → `vault-mcp` again at the suite split's
 * S3c, when "governor" stopped meaning the whole and started meaning the
 * governance PROVIDER that plugs into the host. The npm package name of this
 * SDK did not change either time (it is a published contract), so one SDK build
 * must work against a host on any side of either migration: it reads BOTH ids
 * and subscribes to BOTH ready events.
 *
 * ORDER IS SIGNIFICANT, and it changed at S3c. `vault-mcp` is now the host, and
 * `governor` is the id of a plugin that is NOT a host — the governance
 * provider, which exposes no `api` property. `getApi` skips an id whose plugin
 * has no `api`, so a post-split vault resolves correctly whichever way round
 * the list is; but a vault carrying BOTH a live pre-split host (`governor`) and
 * a live post-split host (`vault-mcp`) must bind to the newer one, and only
 * this order guarantees it.
 */
const HOST_PLUGIN_IDS = ["vault-mcp", "governor"] as const;
/** Ready events, same order and same reason as HOST_PLUGIN_IDS. */
const HOST_READY_EVENTS = ["vault-mcp:ready", "governor:ready"] as const;
/** Why a host's `apiVersion` does not meet the floor, or null when it does.
 *  One predicate for both registration paths, so they cannot drift on what
 *  "supported" means — and the reason names the rule that failed, because the
 *  console line is the only diagnostic a darkened satellite emits and "below
 *  the floor" would send a reader the wrong way for a host that declares no
 *  number at all. */
export function hostApiRefusal(api: { apiVersion?: unknown } | null | undefined): string | null {
  const v = api?.apiVersion;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return `apiVersion ${String(v)} is not a finite number (a host declares a numeric level, at least ${API_VERSION_MIN})`;
  }
  if (v < API_VERSION_MIN) return `apiVersion ${v} is below the supported floor ${API_VERSION_MIN}`;
  return null;
}

/** True when a host's `apiVersion` meets the floor (see `hostApiRefusal`). */
export function hostApiSupported(api: { apiVersion?: unknown } | null | undefined): boolean {
  return hostApiRefusal(api) === null;
}

function isJsonSchema(s: NonNullable<SdkToolSpec["inputSchema"]>): s is JsonSchemaObject {
  // A zod raw shape's values are zod schemas, never the string "object",
  // so checking type alone discriminates safely — and accepts a valid
  // property-less JSON Schema like { type: "object" }.
  return (s as JsonSchemaObject).type === "object";
}

function toJsonSchema(s: SdkToolSpec["inputSchema"]): JsonSchemaObject | undefined {
  if (!s) return undefined;
  if (isJsonSchema(s)) return s;
  // Convert INSIDE the publisher's bundle — zod instances must not cross the
  // plugin boundary (each plugin bundles its own zod copy).
  const js = zodToJsonSchema(z.object(s as Record<string, z.ZodTypeAny>), {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  delete js.$schema;
  return js as unknown as JsonSchemaObject;
}

function toExternalSpec(t: SdkToolSpec): ExternalToolSpec {
  return {
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.inputSchema),
    annotations: {
      readOnlyHint: t.readOnly === true,
      ...(t.destructive !== undefined && { destructiveHint: t.destructive }),
      ...(t.idempotent !== undefined && { idempotentHint: t.idempotent }),
    },
    handler: t.handler,
    ...(t.protection !== undefined && { protection: t.protection }),
    ...(t.sync !== undefined && { sync: t.sync }),
    ...(t.paths !== undefined && { paths: t.paths }),
  };
}

/**
 * The specs a host can be handed. A host below apiVersion 3 ignores the write
 * declarations, so a declaring tool would run there with none of the
 * protection it asked for: FAIL CLOSED and leave it out, with one warning
 * naming each. The other tools register as before.
 */
export function specsForHost(api: { apiVersion?: unknown }, specs: ExternalToolSpec[], owner = "?"): ExternalToolSpec[] {
  const level = typeof api.apiVersion === "number" ? api.apiVersion : 0;
  if (level >= API_VERSION_DECLARATIONS) return specs;
  const kept = specs.filter((s) => !declaresWrites(s));
  if (kept.length < specs.length) {
    const dropped = specs.filter((s) => declaresWrites(s)).map((s) => s.name);
    console.warn(`[vault-mcp-api] host apiVersion ${String(api.apiVersion)} cannot enforce write declarations (needs ${API_VERSION_DECLARATIONS}); not registering '${owner}' tools: ${dropped.join(", ")}`);
  }
  return kept;
}

/**
 * Publish MCP tools through the Vault MCP host. Call from your plugin's onload() and
 * hand the returned disposer to this.register(). Handles load order (registers
 * now or on the host's ready event), re-registration when the host reloads,
 * cleanup. Works against a host on either side of the 0.12.0 `vault-mcp` →
 * `governor` id migration — see HOST_PLUGIN_IDS.
 */
export function publishTools(plugin: Plugin, tools: SdkToolSpec[]): () => void {
  const specs = tools.map(toExternalSpec);
  let unregister: (() => void) | null = null;

  const getApi = (): VaultMcpApi | null => {
    const loaded = (plugin.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: VaultMcpApi }> };
    }).plugins?.plugins;
    for (const id of HOST_PLUGIN_IDS) {
      const api = loaded?.[id]?.api;
      if (!api) continue;
      const refusal = hostApiRefusal(api);
      if (refusal) {
        console.warn(`[vault-mcp-api] '${id}': ${refusal}; not registering '${plugin.manifest.id}' tools`);
        return null;
      }
      return api;
    }
    return null;
  };

  const register = () => {
    const api = getApi();
    if (!api) return;
    try { unregister = api.registerTools(plugin.manifest.id, specsForHost(api, specs, plugin.manifest.id)); }
    catch (e) { console.error(`[vault-mcp-api] registerTools failed for '${plugin.manifest.id}'`, e); }
  };

  register(); // the host may already be loaded
  // On host reload the old registry died with the old plugin instance — drop
  // the stale unregister (don't call it) and register into the new one.
  // Subscribing to both events means a single 0.12.0+ host load runs this
  // twice; that is harmless by the host's own contract — same-owner
  // re-registration REPLACES by tool name, and the superseded disposer is
  // object-identity guarded, so it cannot delete the newer entries.
  const refs = HOST_READY_EVENTS.map((evt) =>
    plugin.app.workspace.on(evt as never, () => { unregister = null; register(); }),
  );

  return () => {
    for (const ref of refs) plugin.app.workspace.offref(ref);
    try { unregister?.(); } catch { /* registry may already be gone */ }
    unregister = null;
  };
}

/**
 * Register governance hooks on the host's seam. The provider-side counterpart
 * of `publishTools`, handling the same three things: load order (the host may
 * load after you), re-registration when the host reloads, and cleanup.
 *
 * Hand the returned disposer to `this.register()`. Revoking is the disposer and
 * only the disposer — there is no id-addressed unregister on either side.
 *
 * WHAT REGISTERING BUYS YOU, precisely: the host hands you the bytes of
 * completed writes (candidates flow outward), and asks you whether to refuse a
 * session (refusals flow inward). Neither direction carries authority. A host
 * with no provider registered is the ordinary, vacuous case — every
 * consultation iterates a possibly-empty list — so the host is a complete
 * product without you, and installing you turns audited access into governed
 * access.
 */
export function registerGovernance(plugin: Plugin, hooks: GovernanceHooks): () => void {
  let disposers: Array<() => void> = [];

  const getSeam = (): GovernanceSeam | null => {
    const loaded = (plugin.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: VaultMcpApi & Partial<GovernanceSeam> }> };
    }).plugins?.plugins;
    for (const id of HOST_PLUGIN_IDS) {
      const api = loaded?.[id]?.api;
      if (!api) continue;
      const refusal = hostApiRefusal(api);
      if (refusal) {
        console.warn(`[vault-mcp-api] '${id}': ${refusal}; not registering '${plugin.manifest.id}' governance hooks`);
        return null;
      }
      // A host predating the seam exposes `registerTools` and nothing else.
      // That is not an error and must not be fatal to the provider's load — it
      // means there is no seam to hold, so nothing is registered.
      if (typeof api.registerWriteObserver !== "function" || typeof api.registerSessionRefusal !== "function") {
        console.warn(`[vault-mcp-api] host '${id}' exposes no governance seam; '${plugin.manifest.id}' registered no hooks`);
        return null;
      }
      return api as GovernanceSeam;
    }
    return null;
  };

  const register = () => {
    const seam = getSeam();
    if (!seam) return;
    const id = plugin.manifest.id;
    try {
      const added: Array<() => void> = [];
      if (hooks.writeObserver) added.push(seam.registerWriteObserver(id, hooks.writeObserver));
      if (hooks.sessionRefusal) added.push(seam.registerSessionRefusal(id, hooks.sessionRefusal));
      disposers = added;
    } catch (e) {
      console.error(`[vault-mcp-api] governance registration failed for '${plugin.manifest.id}'`, e);
    }
  };

  /** Revoke every hook this SDK currently holds. Safe to call repeatedly. */
  const disposeAll = () => {
    for (const d of disposers) { try { d(); } catch { /* seam may already be gone */ } }
    disposers = [];
  };

  register(); // the host may already be loaded
  // CALL the old disposers before re-registering — do not merely drop them.
  //
  // This is where the governance seam differs from `publishTools` above, and
  // copying that function's reasoning here was a real bug (fixed 2026-09-08).
  // `registerTools` REPLACES by tool name, so a second registration by the same
  // owner supersedes the first and dropping the stale disposer is correct. The
  // seam has NO replace-by-id: `registerWriteObserver` / `registerSessionRefusal`
  // APPEND an entry to a list, and `id` addresses nothing. So a dropped-but-live
  // registration is not superseded, it is ORPHANED — and the host fires BOTH
  // `vault-mcp:ready` and `governor:ready` on every single load, so the bug
  // fired on every ordinary load: two write observers (two proposals per write,
  // and a DOUBLE mandate-budget charge), two session-refusal hooks, and one
  // un-disposable ghost of each surviving after the human disables the provider
  // in Obsidian's settings — because this SDK's returned disposer can only
  // revoke the set it still holds.
  //
  // Calling a STALE disposer is harmless on the host-reload path too. Each
  // disposer sets its own `disposed` flag (idempotent) and removes its entry by
  // OBJECT IDENTITY from the list it closed over, so it can neither fire twice
  // nor drop a successor's registration — and if the old seam is gone entirely
  // the throw is caught here. Verified against `packages/host/src/mcp/seam.ts`.
  const refs = HOST_READY_EVENTS.map((evt) =>
    plugin.app.workspace.on(evt as never, () => { disposeAll(); register(); }),
  );

  return () => {
    for (const ref of refs) plugin.app.workspace.offref(ref);
    disposeAll();
  };
}
