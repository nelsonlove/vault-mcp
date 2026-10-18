import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inRecordFolder } from "./records.js";
import { TFile, stringifyYaml, parseYaml, type App } from "obsidian";
import { registerFsTools, ok,
  CHARACTER_LIMIT,
  noteLengthFrom,
  WholeReads,
  wholeReadToken,
} from "@vault-mcp/core";
import { serverInfo, codedError } from "./helpers.js";
import { registerCoreTools, type ServerCtx } from "./tools-core.js";
import { registerVaultWriteTools } from "./tools-vault-write.js";
import { registerSchemeWriteTools } from "./tools-scheme-write.js";
import { registerSurveyTools } from "./tools-survey.js";
import { registerComplementaryTools } from "./tools-complementary.js";
import { registerNavTools } from "./tools-nav.js";
import { registerIntegrationTools } from "./tools-integrations.js";
import { registerImportTools, IMPORTER_PLUGIN_ID } from "./tools-import.js";
import { registerCliTools, obsidianTemplateReader } from "./tools-cli.js";
import { registerCliDedicatedTools } from "./tools-cli-dedicated.js";
import { registerSnippetTools, obsidianSnippetSource } from "./tools-snippets.js";
import { registerExternalTools, externalToolSnapshot } from "./external-tools.js";
import { registerLockTools } from "./tools-locks.js";
import { registerUidTools } from "./tools-uid.js";
import { registerLinkTools, obsidianLinkSource } from "./tools-links.js";
import { createSyncGuard, normalizeSyncGuard, readSyncSnapshot } from "../kernel/sync-guard.js";
import { registerCreateNoteTool } from "./tools-create-note.js";
import { mountModules, schemeModuleEnabled } from "./modules-mount.js";
import { registerCodeModeTools, makeCaptureRegister, type CapturedRegistry } from "./tools-code-mode.js";
import { makeGuarded, resolveGuardedPath, withKernelArgs } from "./guarded.js";
import { inputObjectOf, resolveProfile, profileAllows, profileCallRefusal, isProfileName, SNIPPET_TOOLS, buildRedaction, parseProfileList, scannerFor, type SecretScanner } from "@vault-mcp/core";
import { APP_ONLY_ARGS, APP_ONLY_TOOLS, appOnlyCall, declaredHeadless, headlessRefusal, isHeadless, normalizeHostSettings } from "../headless.js";
import { reportCompletedWrite } from "./seam.js";
import { sealUnguardedRegistration } from "./seal-registration.js";
import { visiblePaths } from "../guard.js";
import type { JournalActor } from "../kernel/index.js";
import { obsidianProbe } from "../kernel/obsidian-probe.js";
import { normalizeRecordIdentification, normalizeRecordFolders, archivePatternRegExp } from "../kernel/record-guard.js";
import { configureArchiveFolders } from "./name-checks.js";
import { ObsidianBackend } from "./obsidian-backend.js";
import { registerWriteNotesTool, batchItemWriter, type GuardedWrite } from "./tools-write-notes.js";
import { uuidv7, formatLocalTimestamp } from "./write-notes-compose.js";
import { makeRegistry, DEFAULT_SCHEMES } from "../kernel/scheme/registry.js";
import { buildMcpActionRegistry } from "../kernel/operations/mcp-registry.js";
import { createOperationExecutor } from "../kernel/operations/executor.js";
import { createCapture } from "../kernel/observations/capture.js";
import { openSession } from "../kernel/sessions/session.js";
import { createConnectionSession, type ConnectionSession } from "../kernel/sessions/connection-session.js";
import type { SessionV1 } from "@vault-mcp/core";
// The session scope digest is the HOST's own assertion about a connection
// (condition 7: the host mints), so these two contracts are consulted here.
// S3, condition 9: promoted into `@vault-mcp/core` — the seam never needed
// them, and now both the host and the governance provider depend on the
// published contract rather than the host reaching into the provider subtree.
import { canonicalize, digestUtf8 } from "@vault-mcp/core";
import { isExcludedTerritory, resolveTerritories } from "@vault-mcp/core";
import { captureAllowed } from "../territory-policy.js";
import { createObservationStore } from "../kernel/observations/store.js";
import { createLocalBlobStore } from "../kernel/observations/local-store.js";
import { vaultSlug } from "../paths.js";
import { collectPaths } from "../guard.js";

export interface BuildOpts {
  /** Code Mode: expose the search/describe/call meta-tool surface instead of the full tool set. */
  codeMode?: boolean;
  /**
   * Receive the captured guarded-tool registry after every registrar has run.
   * Only meaningful with `codeMode: true` — that is the mode in which
   * registrations are CAPTURED rather than registered on the SDK server (a
   * full-surface build hands back an empty registry). The in-Obsidian dev
   * tool-runner (src/tool-runner.ts) uses this to obtain, per invocation, the
   * exact tool set + guard wrappers a fresh code-mode MCP connection would get.
   */
  onRegistry?: (registry: CapturedRegistry) => void;
  /**
   * Journal-actor `client` label for a server no MCP client will ever attach
   * to (the tool-runner's registry-only builds). Used only as a FALLBACK: a
   * real connection's initialize handshake still wins, so an MCP session can
   * never be mislabeled.
   */
  clientLabel?: string;
  /**
   * The connection profile's NAME, from the connection preamble (#521; core's profile.ts). Absent ⇒
   * `full`, the surface a local connection always had. Any other name builds only that profile's
   * tools; an unknown name builds none.
   */
  profile?: string;
}

// `BuildOpts.providerTools` and its `ProviderToolContext` are GONE (S3c).
//
// S2 introduced them as the shape that got the mandate tools off `ServerCtx`:
// registrars handed in by the composition root, closed over the provider's own
// stores, so the host's per-connection context named no provider type. That was
// S2's exit criterion and it held. S3c retires the shape itself, because the
// composition root no longer has a provider to compose — the provider is a
// separate plugin, and it contributes its tools the way every other plugin
// does, through `registerTools` on the api object. One publishing path for
// everybody is the point of the split; a second, privileged one for the
// provider would be the standing this design is careful never to grant it.

// Per-connection id for the journal's actor block. Monotonic within a plugin
// load; the load-time epoch keeps ids from colliding across plugin reloads.
let connSeq = 0;
const CONN_EPOCH = Date.now().toString(36);

export function buildMcpServer(app: App, ctx: ServerCtx, opts: BuildOpts = {}): McpServer {
  // serverInfo, as returned by `initialize` — built by `serverInfo()` in
  // mcp/helpers.ts, which owns the name and is reachable from a plain node
  // test. `vault-mcp` since the S3c wire rename (2026-09-09); it was `governor`
  // between 0.12.0 and the split, which after the split had the handshake
  // introducing this server as the governance provider while it published the
  // host's tools.
  const server = new McpServer(serverInfo(ctx.pluginVersion, ctx.vaultName));
  const connectionId = `${CONN_EPOCH}-${++connSeq}`;

  // Wrap registerTool so every tool handler is guarded before registration.
  // This monkeypatch fires for ALL registerTool calls that follow, including the
  // 17 fs-expressible tools registered via registerFsTools below — because
  // registerFsTools calls server.registerTool, which is this patched version.
  // Cast origRegister to any to bypass overload signature checking on the wrapped handler.
  //
  // The same wrapper also routes MUTATING calls through the plugin-singleton
  // write queue and the write journal (ctx.kernel) — one interception point, so
  // the guarded set, the serialized set, and the journaled set are the same set
  // by construction.
  //
  // In Code Mode the same interception point CAPTURES each guarded tool into a
  // registry instead of registering it; the three meta-tools registered at the
  // end are the only tools the session sees. The guard wrapper travels with
  // the captured handler, so read-only/allowlist bind identically in both modes.
  // THE CONNECTION PROFILE (#521) sits HERE, at origRegister, the one registrar every path ends
  // in: the patched registerTool below (fs tools, hand-registered tools, modules, satellites through
  // registerExternalTools), obsidian_write_notes and the Code Mode meta-tools. A name outside the
  // profile is never registered: absent from tools/list, "not found" on call. The handler of a name
  // inside it keeps a call-time check (profileCallRefusal), outside the guard, so a refused call
  // reaches neither the queue nor the journal. `full` (no profile in the preamble) is unchanged.
  const profile = resolveProfile(opts.profile);
  const sdkRegister: any = server.registerTool.bind(server);
  // THE SECRET SCANNER (core's redaction.ts), OFF unless the settings name this connection's
  // profile. When they do, every reply, refusals included, passes through it here, so no
  // registration path skips it. FAIL CLOSED: settings the scanner refuses (an unknown profile
  // name, a bad config) while a profile is listed give every remote connection, and a local one
  // when `full` is listed, no tools at all, and the reason is logged. A list that cannot be parsed,
  // a name in it that is not a known profile, or a setting of the wrong type refuses every
  // connection, local ones included. They never fall back to sending replies unscanned.
  let scanner: SecretScanner | undefined;
  let redactRefused = false;
  {
    // A logged refusal, never a throw, whatever the settings hold (a hand-edited data.json included).
    const refuseAll = (why: string): void => {
      console.error(`[vault-mcp] secret scanner settings refused (${why}); this connection gets no tools`);
      redactRefused = true;
    };
    try {
      const st = ctx.getSettings() as { redactProfiles?: unknown; redactConfig?: unknown };
      const rawProfiles = st.redactProfiles ?? [];
      const rawConfigValue = st.redactConfig ?? "";
      if (!Array.isArray(rawProfiles) || rawProfiles.some((e) => typeof e !== "string")) {
        refuseAll("redactProfiles is not a list of strings");
      } else if (typeof rawConfigValue !== "string") {
        refuseAll("redactConfig is not text");
      } else {
        const raw = (rawProfiles as string[]).filter((e) => e.trim() !== "");
        const rawConfig = rawConfigValue.trim();
        if (raw.length > 0 || rawConfig) {
          // The list is PARSED first (a line may be a comma list or a JSON array). A list that cannot
          // be parsed, or that holds a name that is not a known profile (`Full`, `- full`,
          // `full # local`), refuses every connection it could have meant, `full` included.
          let listed: string[] | null = null;
          try {
            listed = raw.flatMap((e) => parseProfileList(e));
          } catch {
            listed = null;
          }
          const unknown = listed?.find((n) => !isProfileName(n));
          if (listed === null) refuseAll("the redaction profile list cannot be parsed");
          else if (unknown !== undefined) refuseAll(`the redaction profile list names an unknown profile '${unknown}'`);
          else {
            try {
              const config = rawConfig ? JSON.parse(rawConfig) : undefined;
              scanner = scannerFor(buildRedaction(listed, config), profile.name);
            } catch (e) {
              // A bad config with no profile listed leaves the scanner off and refuses nothing.
              const covers = listed.length > 0 && (profile.tools !== null || listed.includes(profile.name));
              if (covers) refuseAll((e as Error).message);
              else console.error(`[vault-mcp] secret scanner config refused (${(e as Error).message}); no profile is listed, so the scanner stays off`);
            }
          }
        }
      }
    } catch (e) {
      refuseAll(`unexpected error: ${(e as Error).message}`);
    }
  }
  const origRegister: any =
    profile.tools === null && !scanner && !redactRefused
      ? sdkRegister
      : (name: string, def: any, handler: any) => {
          if (redactRefused || !profileAllows(profile, name)) return undefined;
          const mutating = def?.annotations?.readOnlyHint === false;
          const gated = (args: unknown, extra: unknown) => {
            const refused = profileCallRefusal(profile, name, mutating, args, (p) => app.vault.getAbstractFileByPath(p) !== null);
            return refused ? codedError(refused.code, refused.message) : handler(args, extra);
          };
          return sdkRegister(name, def, scanner ? scanner.wrap(gated, { snippets: SNIPPET_TOOLS.has(name) }) : gated);
        };
  // Code Mode under a profile: the meta-tools are outside every profile, so they are not
  // registered, and a captured registry would hide the filter behind obsidian_call_tool. The safe
  // pick: a profiled connection gets the plain, filtered surface, whatever its preamble asked.
  // A scanned or refused connection gets the plain surface too: the meta-tools would hide each
  // tool's reply inside obsidian_call_tool's.
  if (profile.tools !== null || scanner || redactRefused) opts = { ...opts, codeMode: false };
  // Resolved per call, not once: the MCP client's identity only exists after
  // the initialize handshake, which happens well after the server is built.
  // `server` is the transport's own assertion — which vault, which install,
  // which version — and is resolved once at load, not per call.
  // ── the connection's session (WP5, D01) ─────────────────────────────────
  //
  // One durable, replica-local session per connection, minted at build time
  // and recorded in the session store. The record is evidence; the CAPABILITY
  // is this closure — nothing serialized here lets another process act as
  // this session. When no session machinery is wired (tests, bare embeds)
  // the connection simply has no session, and everything downstream treats
  // null as "no session" rather than failing.
  //
  // The session ROTATES on expiry while the connection stays open
  // (`connection-session.ts`): an expired session is marked expired and a new
  // one, `continuedFrom` the old id, is opened — unless the provider refuses
  // the old id (a revocation), which never rotates. So `session` below is read
  // through `conn.current()` every time, never captured.
  let conn: ConnectionSession | null = null;
  if (ctx.sessions) {
    const sessions = ctx.sessions;
    conn = createConnectionSession({
      log: sessions,
      mint: (continuedFrom, now) => {
        const st = ctx.getSettings();
        return openSession(
          {
            vaultId: sessions.vaultId,
            replicaId: sessions.replicaId,
            actor: { connection: connectionId, clientClaim: opts.clientLabel ?? null },
            journalHead: sessions.journalHead(),
            // The effective connection scope at open: read-only + allowlist are
            // what bound this connection's reach. Digested so the record carries
            // a comparable fingerprint, not a second copy of settings.
            scopeDigest: digestUtf8(canonicalize({ readOnly: st.readOnly === true, allowlist: [...(st.allowlist ?? [])].sort() })).value,
            continuedFrom,
          },
          now
        );
      },
      ...(ctx.seam ? { refuse: (id: string | null, purpose: "dequeue" | "rotate") => ctx.seam!.refuseSession(id, purpose) } : {}),
    });

    // The session ends when the connection does. Protocol.onclose is the
    // SDK's own close callback, invoked when the transport closes; chaining
    // preserves anything a later assignment composes on top. A server that
    // never connects (the dev tool-runner) never fires this — its session is
    // bounded by the TTL instead, which is the designed fallback. The close
    // names the session current AT CLOSE, so a rotated connection closes its
    // newest session (the older ones are already logged expired).
    const c = conn;
    const prevClose = (server.server as { onclose?: () => void }).onclose;
    (server.server as { onclose?: () => void }).onclose = () => {
      prevClose?.();
      c.close();
    };
  }
  const currentSession = (): SessionV1 | null => conn?.current() ?? null;

  /**
   * The dequeue refusal for this connection's session — consulted inside the
   * kernel's queued closure, so `WRITE_TIMEOUT_MS` bounds it (condition 5).
   *
   * TWO refusers, and the split is the ruling (condition 7 — the host mints):
   *
   *   • The HOST's own floor: the session record it minted carries an expiry,
   *     and expiry needs no writer and no store to have happened. A host with
   *     no governance provider installed still stops acting under a session
   *     that has run out — the TTL is transport hygiene, not governance.
   *   • The PROVIDER's refusal, through the seam. Revocation is a human act
   *     against the durable record, and the record's revocation state belongs
   *     to whoever owns the review pane the human revoked in. So the host does
   *     not re-read the store to ask permission; it asks the seam whether
   *     anyone wants to refuse, and a `null` from an absent provider is not an
   *     allow — it is silence, which the host's own floor has already spoken
   *     for.
   *
   * The union of the two is exactly what the single store-reading check did
   * before: expired ⇒ refused, revoked/closed ⇒ refused, otherwise proceed.
   * The rotation happens at the top of the guarded wrapper (`sessionRefresh`),
   * never here; this check judges the session the call was ENQUEUED under.
   * See `connection-session.ts`.
   */
  const sessionRefusal = async (enqueuedUnder?: string | null): Promise<{ code: string; detail: string } | null> => {
    if (conn) return conn.refusal(enqueuedUnder);
    return (await ctx.seam?.refuseSession(null)) ?? null;
  };
  const sessionRefresh = async (): Promise<void> => {
    await conn?.refresh();
  };

  const actor = (): JournalActor => {
    const session = currentSession();
    const info = (server.server as any)?.getClientVersion?.();
    // opts.clientLabel is a fallback for builds no client ever connects to
    // (the dev tool-runner): a real handshake identity always takes precedence.
    const client = info?.name ? (info.version ? `${info.name}/${info.version}` : String(info.name)) : opts.clientLabel;
    return {
      transport: "mcp",
      ...(client ? { client } : {}),
      connection: connectionId,
      ...(session ? { session: session.id } : {}),
      ...(ctx.serverIdentity ? { server: ctx.serverIdentity } : {}),
    };
  };
  // Named so obsidian_write_notes' pre-compose resolve (below) can share the
  // IDENTICAL uid/scheme resolution + read-only/allowlist check `guarded`
  // itself applies — not a second copy of it.
  // The write-facts slot (WP6b-1): the backend reports each successful
  // writeNote's exact base/proposed bytes here, and the executor's propose
  // hook takes them immediately after the SAME operation completes. Safe
  // without a queue of its own because the kernel serializes mutations
  // process-wide — at most one write executes at a time, and the take happens
  // before the next can start.
  let writeFacts: { path: string; baseBytes: Uint8Array | null; proposedBytes: Uint8Array; created: boolean } | null = null;

  // ── the operation seam (WP1) ────────────────────────────────────────────────
  //
  // One registry and one executor per CONNECTION, matching the lifetime of the
  // server itself. That is not incidental: a third-party publisher's tool names
  // are computed from whichever plugins are loaded right now, so they only
  // exist at this moment. Binding them here keeps the executor's lookup exact
  // for every surface — including the ones that are not in this repository.
  //
  // Registry problems are reported the way the module host already reports its
  // own: loudly, to the console, without costing the connection. The declared
  // inventory's correctness is a BUILD property with its own test; re-deciding
  // it per connection would turn a build failure into a runtime outage.
  const actions = buildMcpActionRegistry(externalToolSnapshot(ctx));
  for (const p of actions.problems) console.error("[vault-mcp] action registry:", p);
  // ── observation capture (WP2) ───────────────────────────────────────────────
  //
  // DEFAULT OFF. `enabled` is read live, per call, so turning the setting on
  // takes effect without a reconnect — and turning it off stops capture
  // immediately rather than at the end of a session.
  //
  // Payloads land OUTSIDE the vault, in `~/.claude/vault-mcp/observations/<slug>/`,
  // so Obsidian Sync never carries note text a user did not choose to sync.
  //
  // Playback authorization reuses the SAME allowlist the read boundary already
  // enforces. That is deliberate: a reviewer must not be able to replay their
  // way around a path scope, and re-deriving "may this person see this note"
  // from a second rule would be two chances to disagree.
  const observationStore = createObservationStore({
    blobs: createLocalBlobStore({ vaultSlug: vaultSlug(ctx.vaultName ?? "vault") }),
    // Deliberately NOT the capture toggle.
    //
    // The first draft gated playback on `captureObservations`, which meant
    // turning recording OFF also destroyed access to everything already
    // recorded — the opposite of what someone flipping that switch wants. They
    // are stopping new collection, not disowning the evidence they collected.
    //
    // What this gate is FOR is per-reader coarse refusal, and there is no
    // reader identity yet: until sessions (WP5) land, every caller on the
    // socket is the same principal, and the socket is already the trust
    // boundary for live reads. So the honest answer today is "yes, and the
    // allowlist does the scoping" — see canRead directly below. When sessions
    // exist, this becomes a real per-reader question.
    canReplay: () => true,
    canRead: ({ source }) => visiblePaths([source], ctx.getSettings()).length > 0,
  });
  const observationCapture = createCapture({
    store: observationStore,
    // ON requires BOTH the toggle and a non-empty territory list (#397). The
    // settings tab refuses to flip the toggle on an empty list, but a
    // hand-edited data.json can set `captureObservations: true` with none
    // configured — and that is precisely the state in which capture would
    // retain anything at all, including legal material. So the runtime gate
    // is the real one and the UI refusal is courtesy.
    enabled: () => captureAllowed(ctx.getSettings()),
    maxBytes: ctx.getSettings().captureMaxBytes ?? 50 * 1024 * 1024,
    // The OPERATOR'S configured territory list (issue #322: reads in a guarded
    // territory stay legal; RETAINING copies of them outside the territory is
    // what this forbids — capture writes note bodies to
    // `~/.claude/vault-mcp/observations/`, outside the vault and outside Sync).
    //
    // Read LIVE per call, not captured at build time: an operator who adds a
    // territory mid-session must have it honored by the next capture, not at
    // the next reconnect. There is no default for `resolveTerritories` to
    // supply (#397): a blank setting resolves to [] and `captureAllowed`
    // refuses to run on it, which is the whole reason that gate exists.
    //
    // This closes #397. The list is the HOST's setting and Governor reads it
    // from here, rather than the reverse: this consumer is the one that writes
    // bytes outside the vault, and it exists whether or not Governor is
    // installed at all.
    excludedSource: (p: string) => isExcludedTerritory(p, resolveTerritories(ctx.getSettings().guardedTerritories)),
  });

  const executor = createOperationExecutor({
    registry: actions.registry,
    actor: () => {
      const a = actor();
      return { binding: `${a.connection}`, clientClaim: a.client ?? null };
    },
    sessionId: () => currentSession()?.id ?? null,
    // Proposal production, now BEHIND THE SEAM (S2). The executor still
    // decides WHEN — a completed operation — and the host still decides that
    // the facts describe THIS operation. Everything after that is the
    // governance provider's, running as a registered write observer
    // (governor/wiring/write-observer.ts) that the host neither awaits nor
    // reads a return value from.
    //
    // The write-facts slot and its attribution guard stay HERE because they
    // protect the HOST's bookkeeping: the slot is a single-item mailbox filled
    // by the backend and taken exactly once, and a mismatch means the facts
    // belong to some other write. Handing mis-attributed bytes across the seam
    // would manufacture a proposal about a write that did not happen, so the
    // safe direction is to report NOTHING.
    propose: async (operation, _result, sources) => {
      const facts = writeFacts;
      writeFacts = null; // taken exactly once, for exactly this operation
      // Returns immediately: observers are dispatched off this path, so a
      // provider that hangs or throws cannot cost the caller a write that has
      // already landed (condition 5).
      reportCompletedWrite(ctx.seam, facts, operation, sources, actor());
    },
    // The slot is cleared on EVERY close, completed or not — a write whose
    // operation was later judged failed (or a timeout's late settlement) must
    // not leave facts for a future operation to mis-attribute.
    onClose: () => {
      writeFacts = null;
    },
    capture: observationCapture,
    // The paths a call NAMES, via the same walker the guard and the journal
    // already use — so what a payload is attributed to is the same set the
    // allowlist decided over, rather than a second opinion about it.
    // Fallback only. The guard reports the RESOLVED paths through the handler
    // context, which is what actually gets recorded; this covers the case of a
    // handler that returns before resolution happens.
    sourcesOf: (req) => collectPaths((req.inputs ?? {}) as Record<string, unknown>),
  });

  // This connection's memory of whole reads (#443): what obsidian_read_note
  // served whole, and the proof the whole-note rules accept. `noteStat` is
  // the one lookup both the token and the proof are built from.
  const wholeReads = new WholeReads();
  const noteStat = (p: string): { mtime: number; size: number } | undefined => {
    const f = app.vault.getAbstractFileByPath(p);
    return f instanceof TFile ? { mtime: f.stat.mtime, size: f.stat.size } : undefined;
  };
  const guardedOpts = {
    getSettings: () => ctx.getSettings(),
    // The Sync guard (01.43, pick A of 2026-10-12): settings read live per
    // call, the Sync state read fresh on each look. See readSyncSnapshot.
    syncGuard: createSyncGuard(() => ({
      settings: normalizeSyncGuard(ctx.syncGuard?.()),
      read: () => readSyncSnapshot(app),
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    })),
    kernel: ctx.kernel,
    actor,
    wholeReads,
    noteStat,
    noteExists: (p: string) => app.vault.getAbstractFileByPath(p) !== null,
    executor,
    sessionRefusal,
    sessionRefresh,
    // `jd:<address>` addressing at the interception point: same per-call
    // freshness as registerSchemeTools's own registry() below (a scheme
    // config edit lands live), and the same notes() source it uses.
    schemes: () => makeRegistry(ctx.getSettings().schemes ?? DEFAULT_SCHEMES),
    schemeNotes: () => app.vault.getMarkdownFiles().map((f) => f.path),
    // The whole-note-overwrite rule (#441): the note's length as core's
    // noteLengthFrom computes it (the byte size when that cannot exceed the
    // limit, else the character count from the cache).
    noteLength: async (p: string) => {
      const f = app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) return undefined;
      return noteLengthFrom(f.stat.size, () => app.vault.cachedRead(f), CHARACTER_LIMIT);
    },
  };
  const guarded = makeGuarded(guardedOpts);
  const registry: CapturedRegistry = new Map();
  // HEADLESS (headless.ts): the call-time refusal sits OUTSIDE the guard, so a headless call is refused
  // before protection, the Sync guard, the queue and the journal see it (#540 review).
  const headlessMode = () => normalizeHostSettings(ctx.host?.()).headless;
  const headlessGate = (name: string, h: any) =>
    APP_ONLY_TOOLS.has(name) || APP_ONLY_ARGS.has(name)
      ? (args: unknown, extra: unknown) => (appOnlyCall(name, args) && isHeadless(app, headlessMode()) ? headlessRefusal(name) : h(args, extra))
      : h;
  const capture = makeCaptureRegister(registry, (def: any, handler: any, name: string) => headlessGate(name, guarded(def, handler, name)));
  const register = opts.codeMode
    ? capture
    : (name: string, def: any, handler: any) => origRegister(name, def, headlessGate(name, guarded(def, handler, name)));
  // withKernelArgs runs on the way in, so `if_rev` / `idempotency_key` are
  // declared on every mutating tool's schema — in both modes, and for external
  // tools too — without any registrar knowing they exist. Undeclared arguments
  // are stripped by the SDK's own validation, so declaring here is what makes
  // them reachable by a client at all.
  // HEADLESS (headless.ts): a tool that needs the Obsidian app is not offered when headless is
  // declared (the `host.headless` setting or VAULT_MCP_HEADLESS); otherwise `headlessGate` above
  // refuses it with `headless_unsupported` when the call-time look finds no workspace leaf, rather
  // than reporting success with nothing done or running the obsidian CLI against no app.
  // STRICT WRITES (#510, Nelson's pick A of 2026-10-12): a write tool vault-mcp itself registers refuses an
  // argument it does not name ("Unrecognized key(s)"), where the SDK's plain object would drop it and run
  // the call without it, which is how two notes lost their frontmatter on 2026-10-09. The kernel arguments
  // are added after, by withKernelArgs, and extendInput keeps the object strict. Satellite tools (other
  // plugins', through registerExternalTools) keep their own schemas: `registeringExternal` is set there.
  let registeringExternal = false;
  const strictIfWrite = (def: any) =>
    !registeringExternal && def?.annotations?.readOnlyHint === false ? { ...def, inputSchema: inputObjectOf(def.inputSchema).strict() } : def;
  (server as any).registerTool = (name: string, def: any, handler: any) => {
    if (APP_ONLY_TOOLS.has(name) && declaredHeadless(headlessMode())) return undefined;
    return register(name, withKernelArgs(strictIfWrite(def), name), handler);
  };
  const withExternal = (fn: () => void) => {
    registeringExternal = true;
    try {
      fn();
    } finally {
      registeringExternal = false;
    }
  };

  // Patching registerTool alone left FIVE other registration entry points on
  // the SDK server unguarded (#83). Sealing them is what makes module.ts's
  // "no module-specific bypass possible" true by construction rather than by
  // convention — load-bearing because moduleFromRegistrar hands adapted
  // modules the real server, and #83 mounts the accept-veto module here.
  sealUnguardedRegistration(server);

  // ── 17 fs-expressible tools — shared registry + live ObsidianBackend ────────
  // decodeHtml: false — no HTML entities expected from in-process calls.
  // includeIndexStatus omitted — Obsidian's cache is always live; read tools
  // don't need an index_status block.
  // rev: the same mtime token the journal records, so a read hands back exactly
  // what a following write can pass as `if_rev`.
  //
  // The backend also carries the READ BOUNDARY (slice 3.0): six of its methods
  // enumerate the vault with no path to guard, so they filter their own
  // iteration through the allowlist. The filter is resolved per call, like the
  // guard's own settings, so a settings change lands without a reconnect.
  // The same two live getters main.ts hands the plugin-singleton guard probe
  // (`this.settings.enforceRecordImmutability`, `this.settings.recordIdentification`),
  // reached through ctx's own thunks, never `getSettings()`, which withholds both
  // (settings-projection WITHHELD). The probe's `.rev` feeds the fs tools and its
  // `.record()` is obsidian_rename_heading's record skip; the moves' own record
  // test (records.ts) takes the same identification, so a move, a heading rename
  // and the kernel's guard judge a record the same way (#397).
  // The note indicator and the folder indicator (#482) travel together: every
  // move's record test reads both from this one getter (records.ts RecordRules);
  // the guard's probe reads only the note indicator from it.
  const recordIdentification = () => ({
    ...normalizeRecordIdentification(ctx.recordIdentification?.()),
    folders: normalizeRecordFolders(ctx.recordFolders?.()),
  });
  // Nelson's bracket rule asks the same archive pattern which folders are archives;
  // with "Records by folder" off, no folder is an archive for it either.
  configureArchiveFolders(() => {
    const f = normalizeRecordFolders(ctx.recordFolders?.());
    return f.enabled ? archivePatternRegExp(f.archivePattern) : null;
  });
  // The guard's probe reads only the note marker: no folder settings built on its hot path.
  const probe = obsidianProbe(app, () => ctx.enforceRecordImmutability?.() !== false, () => normalizeRecordIdentification(ctx.recordIdentification?.()));
  const visible = (paths: string[]) => visiblePaths(paths, ctx.getSettings());
  // Hoisted so obsidian_write_notes can drive the same backend writeNote through
  // its own per-item guarded dispatch (see the write-notes block below).
  const backend = new ObsidianBackend(app, visible, (facts) => {
    writeFacts = facts;
  }, recordIdentification);
  registerFsTools(server, backend, {
    decodeHtml: false,
    // obsidian_write_note's `frontmatter` (#500) is serialized as obsidian_write_notes serializes an item's.
    stringifyYaml,
    rev: (p) => probe.rev(p),
    // The token a whole read is remembered under: the mtime (the rev the
    // caller will condition on) and the size (a coarse-mtime volume keeps
    // the mtime across an edit in the same tick), sampled before the read.
    // Only with a kernel: without one if_rev is refused outright, so no
    // whole read could ever be proven, and the memory would only mislead.
    ...(ctx.kernel
      ? {
          wholeToken: (p: string) => {
            const st = noteStat(p);
            return st ? { token: wholeReadToken(st.mtime, st.size), rev: st.mtime } : undefined;
          },
          onWholeRead: (p: string, token: string) => wholeReads.remember(p, token),
          // A cut read served after the whole read: the text the caller holds
          // may be the cut one, so the proof is forgotten.
          onCutRead: (p: string) => wholeReads.forget(p),
        }
      : {}),
  });

  // ── remaining tools — live-only, complementary, nav, integrations ────────────
  registerCoreTools(server, app, ctx);
  // ctx carries the guard's settings: obsidian_repoint_link scans the vault for
  // itself, so it must contain that scan by the allowlist on its own — no
  // argument-level check can see a set the handler discovers.
  // isRecord: obsidian_rename_heading rewrites links in notes it discovers,
  // which the kernel's record check (paths an operation NAMES) cannot see.
  // A heading rename leaves a record's links as written, judged as a move judges it: the note marker (the
  // guard's probe) OR the record folders (#482 round 4: it used to read the marker only).
  const isRecordForRename = (p: string): boolean => {
    if (probe.record?.(p) === true) return true;
    return inRecordFolder(p, normalizeRecordFolders(ctx.recordFolders?.()));
  };
  registerVaultWriteTools(server, app, { getSettings: () => ctx.getSettings(), isRecord: isRecordForRename, recordIdentification });
  // ── scope-provider write surface: assign/refile/renumber address ───────────
  // Cannot go through mountModules below: that host's registerAll gate refuses
  // any tool whose readOnlyHint !== true (its own header comment), and these
  // three mutate by design. Registered directly, same shape as
  // registerVaultWriteTools above. Reuses guardedOpts.schemes/schemeNotes
  // rather than building a third `makeRegistry(...)` closure identical to the
  // one guardedOpts already constructed above — same per-call freshness (a
  // scheme config edit lands live, no reconnect needed), one expression.
  // The scheme module's toggle gates these three too (01.28 rule 7, pick A of
  // 2026-10-09): read once per connection, as mountModules reads it below.
  if (schemeModuleEnabled(ctx.getSettings())) {
    registerSchemeWriteTools(server, app, {
      registry: guardedOpts.schemes,
      notes: guardedOpts.schemeNotes,
      getSettings: () => ctx.getSettings(),
      recordIdentification,
    });
  }
  // Folded in from obsidian-jd-survey (2026-08-19). Hand-registered here, the
  // same shape registerSchemeWriteTools above uses: modules-mount.ts's
  // registerAll gate refuses a non-readOnlyHint tool unless its module opts
  // in via `mutating: true` — a real path (five other modules take it), just
  // not the one chosen for this v1's obsidian_survey_slot.
  registerSurveyTools(server, app, {
    getSettings: () => ctx.getSettings(),
  });
  // obsidian_create_note (#531): a note of a class, through the vault's own
  // flow.applyFileclass (rendered in memory, written once). Registered only when the createNoteFlow setting
  // names the module, read once per connection like the module toggles.
  if ((ctx.createNoteFlow?.() ?? "").trim()) {
    registerCreateNoteTool(server, app, {
      getSettings: () => ctx.getSettings(),
      flowPath: () => ctx.createNoteFlow?.() ?? "",
      // The host's own guarded create (accept guard, protected properties, name rules, parent folders).
      writeNote: (p: string, content: string) => backend.writeNote(p, content, false),
      revOf: (p: string) => {
        const r = probe.rev(p);
        return typeof r === "number" ? r : undefined;
      },
    });
  }
  // "QuickAdd choices as notes" EXTRACTED (suite-split, first satellite):
  // it now lives in packages/quickadd-choices-compile, publishing
  // `quickadd_choices_compile_run` through vault-mcp-api like any third-party
  // plugin. The execution seam (running a choice) moved to `@vault-mcp/core`
  // at S5, when triage left too: its two callers — obsidian_run_command here
  // and the vaultmcp-triage satellite's declared choice rows — are now in
  // different plugins, and the seam exists so they cannot drift.
  registerComplementaryTools(server, app, ctx);
  // ctx: obsidian_list_bookmarks enumerates paths the human bookmarked, which
  // is another argument-less read of vault structure.
  registerNavTools(server, app, ctx);
  registerIntegrationTools(server, app, ctx);
  // ── headless Apple Notes import (#252) ─────────────────────────────────────
  // Conditional on the community Importer plugin's LOADED instance, same
  // gate discipline as registerIntegrationTools; mutating, so it registers
  // directly here (modules-mount.ts refuses readOnlyHint !== true). The
  // handler re-resolves the instance per call and version-gates against the
  // known-good importer versions — see tools-import.ts's header.
  registerImportTools(server, app, {
    importerPlugin: () => ((app as any).plugins?.plugins?.[IMPORTER_PLUGIN_ID] ?? null),
    getSettings: () => ctx.getSettings(),
  });
  // ── advisory scope claims (kernel v0) ──────────────────────────────────────
  // Registered here, after the interception patch, so a claim is guarded,
  // serialized and journaled like any other mutating operation — the claim is
  // itself an act the audit stream should record.
  registerLockTools(server, ctx, actor);
  // ── the uid index's read surface (identity substrate, Delivery step 2) ─────
  // Addressing by uid needs no tool of its own — `uid:<value>` binds at the
  // interception point above — so this is purely the lookup, in both directions.
  registerUidTools(server, ctx);
  // ── THE GOVERNANCE PROVIDER'S FIVE TOOLS ARE NOT REGISTERED HERE ──────────
  //
  // `governance_pending_review`, `governance_revisions`,
  // `governance_submit_revision`, `governance_mandate_draft` and
  // `governance_mandates` were hand-registered at this point until S3c. §6 of
  // the split design always assigned them to the provider; they published from
  // here only because that is where the tool tables lived.
  //
  // They now arrive through `registerExternalTools` below, like every other
  // plugin's tools — the same guard, the same queue, the same journal, the same
  // kernel arguments. THEIR NAMES DID NOT CHANGE: the host's grandfather table
  // (`external-tools.ts`) lets the `governor` publisher — and only it, and only
  // for those five names — publish unprefixed, including past the F1
  // `obsidian_*` refusal. Every other satellite paid the rename tax; these five
  // were on the wire when the split happened, and renaming a shipped tool name
  // breaks agent sessions for zero semantic gain.
  //
  // WHAT DID CHANGE, and it is a real cost: as external tools their read-only
  // claims are distrusted unless an operator lists `governor` in
  // `trustedReadOnlyPlugins`, and under an active path allowlist the F3 gate
  // blocks any external tool whose arguments carry no recognized path key — so
  // four of the five are refused wholesale while an allowlist is active, and
  // only `governance_submit_revision` (which takes `path`) stays scoped
  // per-path. They also lose their in-tool `isVisible` filtering, because a
  // satellite cannot reach the host's guard settings. Stricter, fail-closed,
  // and the same finding every extraction since S4 has recorded.
  //
  // ── capability modules: scope-provider ────────────────────────────────────
  // Ruled decision #2 realized: the capability modules register THROUGH
  // the ModuleRegistry — settings-toggleable (`modules.<id>.enabled`), behind
  // the accept/baseline tripwire, collision refusal, and the mount's
  // read-only-only registrar. The registrar handed over is the PATCHED
  // registerTool above, so module tools land at the same guard/queue/journal
  // interception point as every hand-registered tool, in both modes.
  const moduleRegistry = mountModules((name, def, handler) => (server as any).registerTool(name, def, handler), {
    getSettings: () => ctx.getSettings(),
    schemeNotes: () => app.vault.getMarkdownFiles().map((f) => f.path),
    // Nine module adapters were wired HERE until the suite split extracted
    // them. Vocab, health and bases went at S7; fileclass, provenance and
    // jd-scaffold followed as the mutating tier, taking the CLI/vault-name
    // probe, the provenance backend, and the jd-scaffold source + its
    // parseYaml injection with them. Every one of the nine builds its own
    // adapter inside its own plugin now, so this composition root supplies
    // exactly what the two remaining modules need: the settings thunk and the
    // scheme module's note listing.
  });
  // Skip-and-report only reports if someone reads the report: every mount
  // defect (unknown module id in settings, a gate-refused tool, a config
  // finding) lands loudly in the console rather than evaporating with the
  // discarded registry. console.error, not a throw — a degraded module
  // surface must not cost the connection (the journal's own convention).
  for (const p of moduleRegistry.problems) console.error("[vault-mcp] module host:", p);
  // ── link drift, reported not repaired (slice 2.2) ──────────────────────────
  // Read-only by construction: moves already heal their own links (moveWithLinks
  // rewrites them and checks for damage), so this reports the drift that came
  // from OUTSIDE.
  registerLinkTools(server, obsidianLinkSource(app), ctx);
  // ── conformance debt register: MOVED to the vaultmcp-conformance satellite ──
  // `obsidian_conformance_debt` and `obsidian_conformance_debt_render` were
  // registered here until 2026-10-14. The rail (engine, packs, CLI, debt tools,
  // Drift pane, vault conventions) is now `packages/conformance`, publishing
  // `vaultmcp_conformance_debt` and `vaultmcp_conformance_debt_render` through
  // vault-mcp-api; it reads the guarded territories through the api.
  // ── official-CLI proxy — conditional on the CLI binary being installed ──────
  // AND on the default-OFF "Raw CLI proxy" setting (Security tab): the
  // dedicated pinned-subcommand tools below cover the real usage, so the
  // free-text proxy is a surface a human opts back into.
  // parseYaml is injected for the accept-forbidden guard's content-fence scan;
  // readTemplate for the template guard (create template= / quickadd:run-
  // template path= draw content from a vault note the params only NAME).
  // Both injected so tools-cli.ts stays obsidian-free for headless tests.
  registerCliTools(server, ctx, { parseYaml, readTemplate: obsidianTemplateReader(app) });
  // ── dedicated pinned-subcommand CLI tools (the obsidian_cli decomposition) ──
  // Same transport machinery (vault pinning, exec seam, deny list), one PINNED
  // subcommand per tool with typed args — conditional on the CLI binary only,
  // not on the raw-proxy setting. history:restore is deliberately not among
  // them (#110).
  registerCliDedicatedTools(server, ctx, { parseYaml });
  // ── CSS snippet tools — live app API (app.customCss), always registered ─────
  // The considered `.obsidian` exception: scoped to `.obsidian/snippets/*.css`
  // and nothing else (see tools-snippets.ts's header).
  registerSnippetTools(server, ctx, { source: obsidianSnippetSource(app as any) });
  // ── externally-published tools (other Obsidian plugins via plugin.api) ─────
  withExternal(() => registerExternalTools(server, app, ctx));

  // ── batch write + server-side stamping (slice B1) ───────────────────────────
  // obsidian_write_notes is a DISPATCHER, not a single mutating op: to give each
  // item its own journal record it drives a per-item guarded single-writer, and
  // to avoid a reentrant queue deadlock it must not itself take a queue slot. So
  // it registers UNGUARDED via origRegister (the obsidian_call_tool precedent)
  // and each item runs through `guardedWrite` — a real makeGuarded wrapper, so
  // uid/read-only/allowlist/if_rev/idempotency/queue/journal all bind per item.
  // Not registered in Code Mode: that surface is the three meta-tools only, and
  // a session there reaches single writes via obsidian_call_tool.
  if (!opts.codeMode) {
    const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    const guardedWrite = guarded(
      { title: "write one note", inputSchema: {}, annotations: RW },
      // Per item, as write_note (01.33); the rule and why it runs at dequeue:
      // batchItemWriter in tools-write-notes.ts.
      batchItemWriter((p, c, o) => backend.writeNote(p, c, o), (p) => app.vault.getAbstractFileByPath(p) !== null),
      "obsidian_write_notes"
    ) as unknown as GuardedWrite;
    registerWriteNotesTool(origRegister, guardedWrite, {
      // Same resolution + read-only/allowlist check `guarded` applies at
      // dispatch, shared via guardedOpts — see resolveGuardedPath's doc
      // comment and tools-write-notes.ts for why this must run BEFORE compose.
      resolveTarget: (path) => resolveGuardedPath(path, guardedOpts),
      readExistingFrontmatter: (path) => {
        const f = app.vault.getAbstractFileByPath(path);
        return f instanceof TFile ? app.metadataCache.getFileCache(f)?.frontmatter ?? undefined : undefined;
      },
      revOf: (path) => probe.rev(path),
      stringifyYaml,
      parseYaml,
      mintUid: (createdMs) => uuidv7(createdMs),
      formatTs: formatLocalTimestamp,
    });
  }

  if (opts.codeMode) {
    // Meta-tools register through origRegister directly: they must NOT be
    // guard-wrapped — obsidian_call_tool would otherwise be blocked wholesale
    // in read-only mode, blocking read tools too. The captured handlers carry
    // the guard — and the queue and journal — so enforcement happens per target
    // call. That also keeps the queue non-reentrant: obsidian_call_tool itself
    // never takes a queue slot, so its target can't wait on its own caller.
    // The capture patch is
    // deliberately LEFT INSTALLED: any post-build registration still lands in
    // the registry, guarded — the "every registerTool call is guarded" locked
    // invariant holds in both modes for the server's whole lifetime.
    registerCodeModeTools(server, registry, origRegister);
  }
  // Hand the captured registry to the caller AFTER every registrar above has
  // run, so a registry-only consumer (the dev tool-runner) sees the complete
  // guarded tool set of this build — including conditional registrations.
  opts.onRegistry?.(registry);
  return server;
}
