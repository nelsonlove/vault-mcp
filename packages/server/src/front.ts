/**
 * front.ts — Unified presence-aware front for the Obsidian vault MCP server.
 *
 * ONE Express app that:
 *   1. Gates /mcp with shared auth (static bearer or OAuth 2.1 — same gate as
 *      remote-proxy.ts).
 *   2. Routes to the LIVE proxy (plugin-backed, 44 tools) when Obsidian's plugin
 *      Unix socket is reachable.
 *   3. Falls back to the FS handler (filesystem-only, 17 tools) otherwise.
 *
 * The endpoint therefore survives Obsidian closing (graceful degradation) and
 * automatically returns to LIVE mode when the plugin reopens.
 *
 * Usage (injectable, for testing):
 *   const app = buildFront({ cfg, token, presence, fs, live });
 *
 * Production entrypoint (module tail, only when executed directly):
 *   node dist/front.js
 */

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import {
  loadAuthConfig,
  protectedResourceMetadata,
  prmPath,
  createAuthGate,
  isAllowlistActive,
  isAllowAnyAuthenticated,
  type AuthConfig,
} from "./auth.js";
import { createPresenceMonitor } from "./presence.js";
import { createFsHandler, isFsWritesEnabled } from "./fs-mode.js";
import { createLiveProxy } from "./live-proxy.js";
import { createSemanticProxy } from "./semantic-proxy.js";
import { loadProfileMap, createProfileGate, credentialOf, profileOf, type ProfileMap } from "./profiles.js";
import { loadRedaction } from "./redaction-env.js";
import { DEFAULT_RATE_LIMITS, loadRateLimitConfig, createIpRateLimit, createCredentialRateLimit, type RateLimitConfig } from "./rate-limit.js";
import { createRequestLog, createLogWriter, loadRequestLogConfig } from "./request-log.js";

// ── Injectable factory ────────────────────────────────────────────────────────

export interface FrontDeps {
  cfg: AuthConfig;
  token?: string;
  presence: { isLive(): boolean };
  fs: { handle(req: Request, res: Response): Promise<void> };
  live: { handle(req: Request, res: Response): Promise<void> };
  /**
   * Phase 2b: when set (VAULT_MCP_SEAMLESS=1), ALL /mcp traffic routes to the
   * MCP-semantic proxy, which owns the tool list per session and can flip it
   * 44↔17 mid-session via tools/list_changed. Default off — Phase 2a routing.
   */
  seamless?: { handle(req: Request, res: Response): Promise<void> };
  /** Credential → connection profile (profiles.ts, #521). Absent ⇒ unconfigured: every credential gets `full`. */
  profiles?: ProfileMap;
  /** Per-IP and per-credential limits on /mcp (rate-limit.ts). Absent ⇒ the defaults. */
  rateLimits?: RateLimitConfig;
  /** Where the request log's lines go (request-log.ts). Absent ⇒ nowhere. */
  logWrite?: (line: string) => void;
  /** Express "trust proxy": who may name the client IP in X-Forwarded-For. Absent ⇒ "loopback" (tailscale serve, cloudflared). */
  trustProxy?: boolean | number | string;
}

/**
 * The paths the endpoint answers on, derived from MCP_RESOURCE_URL (never hard-coded): `/mcp`
 * always, and the resource URL's own path too (e.g. `/vault-mcp/mcp` behind a `tailscale serve
 * --set-path /vault-mcp` mount that may or may not strip its prefix). `mount` is that path less a
 * trailing `/mcp` (`/vault-mcp`), or "" when there is none.
 */
export function endpointPaths(resourceUrl: string): { resourcePath: string; mount: string; mcp: string[] } {
  let resourcePath = "";
  try {
    resourcePath = resourceUrl ? new URL(resourceUrl).pathname.replace(/\/+$/, "") : "";
  } catch {
    resourcePath = "";
  }
  const mount = resourcePath.endsWith("/mcp") ? resourcePath.slice(0, -"/mcp".length) : "";
  const mcp = [...new Set(["/mcp", ...(resourcePath ? [resourcePath] : [])])];
  return { resourcePath, mount, mcp };
}

/**
 * Every path the protected-resource metadata is served at (RFC 9728 §3.1): the bare well-known
 * path, its `/mcp` suffix (today's form), the resource path's suffix (`…/vault-mcp/mcp`), and each
 * of those again under the mount, for a proxy that does not strip it.
 */
export function prmPaths(resourceUrl: string, underResource = false): string[] {
  const { resourcePath, mount } = endpointPaths(resourceUrl);
  const base = [prmPath(), `${prmPath()}/mcp`, ...(resourcePath ? [`${prmPath()}${resourcePath}`] : [])];
  // VAULT_MCP_PRM_UNDER_RESOURCE: also inside the endpoint's path, on the resource path and on /mcp
  // (a proxy may or may not strip its mount).
  const inside = underResource ? [...new Set(["/mcp", ...(resourcePath ? [resourcePath] : [])])].map((p) => `${p}${prmPath()}`) : [];
  return [...new Set([...base, ...(mount ? base.map((b) => `${mount}${b}`) : []), ...inside])];
}

export function buildFront(deps: FrontDeps): express.Express {
  const { cfg, token, presence, fs: fsHandler, live, seamless } = deps;

  const authGate = createAuthGate(cfg, { token });
  // The order on /mcp (#521): the request log first (so a refusal is logged too), the per-IP limit
  // before auth (a guesser is slowed), auth, the profile, the per-credential limit, then the body.
  const profileGate = createProfileGate(deps.profiles ?? { configured: false, entries: new Map() });
  const limits = deps.rateLimits ?? DEFAULT_RATE_LIMITS;
  const ipLimit = createIpRateLimit(limits.ipPerMin);
  const credLimit = createCredentialRateLimit(limits.credPerMin, credentialOf);
  const requestLog = createRequestLog(deps.logWrite ?? (() => undefined), { credential: credentialOf, profile: profileOf });
  const paths = endpointPaths(cfg.resourceUrl);
  // Body parsing is scoped to /mcp and applied AFTER authGate so unauthenticated
  // callers cannot force a 10 MB JSON parse before the 401.
  const parseBody = express.json({ limit: "10mb" });

  const app = express();
  // req.ip (the rate limit, the log) names the client only as far as a trusted proxy says.
  app.set("trust proxy", deps.trustProxy ?? "loopback");

  // Health — no auth, no body parse.
  // `mode` tells a monitor whether the proxy is in live or fallback mode.
  // `fsWriteSyncCaveat` flags that FS-mode writes bypass Obsidian's sync pipeline.
  // `fsWritesEnabled` (issue #92) reports whether FS-mode writes are currently
  // permitted at all — FS mode has no journal/serialized queue (those live in
  // the plugin's kernel), so writes made there are refused unless the deployment
  // opted in via VAULT_MCP_FS_ALLOW_WRITES. A boolean, not a secret.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: presence.isLive() ? "live" : "fs",
      authEnabled: cfg.enabled,
      fsWriteSyncCaveat: true,
      fsWritesEnabled: isFsWritesEnabled(),
    });
  });

  // OAuth Protected Resource Metadata (RFC 9728) — tells claude.ai which AS to
  // use. Public by spec (names the AS, no secrets). Served at the bare path and
  // the resource-scoped /mcp variant so either discovery probe works. Only when
  // OAuth is enabled.
  if (cfg.enabled) {
    const prm = (_req: Request, res: Response): void => {
      res.json(protectedResourceMetadata(cfg));
    };
    for (const p of prmPaths(cfg.resourceUrl, cfg.prmUnderResource === true)) app.get(p, prm);
  }

  // MCP endpoint — auth gate, then body parse, then presence-based routing.
  // All three HTTP verbs are wired (POST = new/stateless, GET = SSE stream,
  // DELETE = session teardown) so the full Streamable HTTP protocol is supported.
  const handler = (req: Request, res: Response): void => {
    if (seamless) {
      void seamless.handle(req, res);
      return;
    }
    void (presence.isLive() ? live.handle(req, res) : fsHandler.handle(req, res));
  };

  for (const method of ["post", "get", "delete"] as const) {
    for (const p of paths.mcp) app[method](p, requestLog, ipLimit, authGate, profileGate, credLimit, parseBody, handler);
  }

  // Turn body-parser failures (oversized payloads etc.) into JSON-RPC errors
  // instead of Express's default HTML error page, which an MCP client can't parse.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; message?: string };
    const tooLarge = e?.type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: tooLarge ? "request body too large" : (e?.message ?? "bad request"),
      },
      id: null,
    });
  });

  return app;
}

// ── Presence-to-LIVE-proxy failover wiring ────────────────────────────────────
//
// Notifies open SSE channels (best-effort) that the tool surface changed, then
// tears down LIVE sessions when Obsidian closes.  New requests auto-route to FS
// mode via the request-time presence.isLive() check already in buildFront.
// FS-mode and POST-only clients discover the new surface on their next
// initialize (seamless push is Phase 2b).

const LIST_CHANGED = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
  params: {},
} as const;

export function wireFailover(deps: {
  presence: { on(ev: "up" | "down", cb: () => void): void };
  live: { teardownAll(): void; notifyAll(msg: object): void };
  fs: { ready(): Promise<void>; stop(): Promise<void> };
}): void {
  const { presence, live, fs } = deps;

  // When Obsidian closes: push list_changed to any open SSE channels, tear down
  // live sessions (their plugin backend is gone), and prewarm the FS index so
  // the first FS-mode request is fast.
  presence.on("down", () => {
    live.notifyAll(LIST_CHANGED);
    live.teardownAll();
    void fs.ready().catch(() => {});
  });

  // When Obsidian comes back: best-effort nudge; new connects resolve to LIVE
  // via the request-time isLive() check. Do NOT tear down live sessions. STOP
  // the FS vault watcher — it must not run during LIVE mode, where a live
  // watcher corrupts child_process fd setup under launchd and EBADFs the bridge
  // spawn. fs.stop() re-arms ready() so a later FS return rebuilds it.
  presence.on("up", () => {
    live.notifyAll(LIST_CHANGED);
    void fs.stop().catch(() => {});
  });
}

/** VAULT_MCP_TRUST_PROXY: "true"/"false", a hop count, or Express's own words ("loopback", a CIDR list). */
export function parseTrustProxy(raw: string): boolean | number | string {
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false" || v === "") return false;
  if (/^\d+$/.test(v)) return Number(v);
  return raw.trim();
}

// ── Socket path resolution ────────────────────────────────────────────────────
//
// The plugin writes its Unix socket at `~/.claude/vault-mcp/<slug>.sock` where
// `slug` is the vault name lowercased with non-alphanumeric chars replaced by `-`.
// This mirrors the `vaultSlug()` + `socketPath()` helpers in packages/host/src/paths.ts
// without adding a cross-package dependency.
//
// Override order (highest priority first):
//   VAULT_MCP_SOCKET      — absolute path; use exactly as given
//   VAULT_MCP_STATE_DIR   — directory; slug derived from VAULT_PATH basename
//   (default)             — ~/.claude/vault-mcp/<slug>.sock

function resolveSocketPath(): string {
  if (process.env.VAULT_MCP_SOCKET) return process.env.VAULT_MCP_SOCKET;

  const stateDir =
    process.env.VAULT_MCP_STATE_DIR ??
    path.join(homedir(), ".claude", "vault-mcp");

  const vaultPath = process.env.VAULT_PATH ?? "./vault";
  const vaultName = path.basename(path.resolve(vaultPath));
  const slug = vaultName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return path.join(stateDir, `${slug}.sock`);
}

// ── Production entrypoint ─────────────────────────────────────────────────────
//
// Guarded by the isMain check so the module can be imported by tests without
// triggering the startup guards or process.exit() calls.

const _thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === _thisFile) {
  const PORT = Number(process.env.PORT ?? 8787);
  const HOST = process.env.HOST ?? "127.0.0.1";
  const TOKEN = process.env.VAULT_MCP_TOKEN ?? "";
  const BRIDGE =
    process.env.VAULT_MCP_BRIDGE ??
    path.join(homedir(), ".claude", "vault-mcp", "bridge.mjs");
  // Reap sessions idle longer than this. 30 min is generous enough to avoid tearing
  // down a live-but-idle session mid-conversation; clients re-initialize on the
  // next 404 if the session was reaped. Tune via VAULT_MCP_IDLE_MS.
  const IDLE_MS = Number(process.env.VAULT_MCP_IDLE_MS ?? 30 * 60 * 1000);
  // Hard cap on concurrent bridge.mjs backends to prevent process floods.
  const MAX_SESSIONS = Number(process.env.VAULT_MCP_MAX_SESSIONS ?? 32);

  const cfg = loadAuthConfig();

  // Fail-closed: a profile mapping that does not parse must not fall back to `full` (#521).
  let profiles: ProfileMap;
  try {
    profiles = loadProfileMap();
  } catch (e) {
    console.error(`[front] refusing to start: ${(e as Error).message}`);
    process.exit(1);
  }

  // Fail-closed: secret scanner settings that are refused must not leave a profile unscanned.
  try {
    const redaction = loadRedaction();
    if (redaction && redaction.profiles.size > 0) {
      console.error(`[front] secret scanner on (FS mode) for: ${[...redaction.profiles].join(", ")}`);
      console.error(
        "[front] WARNING: VAULT_MCP_REDACT_PROFILES applies to FS mode only. While the Obsidian plugin is reachable the front proxies LIVE mode, " +
          "and the plugin's own settings (Secret scanner: profiles and config) decide which replies are scanned there.",
      );
    }
  } catch (e) {
    console.error(`[front] refusing to start: ${(e as Error).message}`);
    process.exit(1);
  }

  // Fail-closed: a public endpoint must NEVER run unauthenticated.
  if (!TOKEN && !cfg.enabled) {
    console.error(
      "[front] refusing to start: no auth configured. Set VAULT_MCP_TOKEN " +
        "(static Bearer) and/or AUTH_ENABLED=true with the AUTH_* vars (OAuth). " +
        "A public endpoint must never run unauthenticated.",
    );
    process.exit(1);
  }

  // Fail-closed: OAuth on with no allowlist accepts EVERY valid token — on a
  // public-sign-up AS that is an open vault. Require opt-in.
  if (cfg.enabled && !isAllowlistActive() && !isAllowAnyAuthenticated()) {
    console.error(
      "[front] refusing to start: AUTH_ENABLED=true with no AUTH_ALLOWED_SUBS / " +
        "AUTH_ALLOWED_EMAILS. A valid token would grant vault access to ANY user " +
        "who can sign up at the AS. Set an allowlist, or AUTH_ALLOW_ANY_AUTHENTICATED=true " +
        "to opt in.",
    );
    process.exit(1);
  }

  const socketPath = resolveSocketPath();

  const presence = createPresenceMonitor({
    socketPath,
    pollMs: Number(process.env.VAULT_MCP_PRESENCE_POLL_MS ?? 5000),
  });

  const fsHandler = createFsHandler({ indexStatus: true });

  const liveProxy = createLiveProxy({
    bridgePath: BRIDGE,
    maxSessions: MAX_SESSIONS,
    idleMs: IDLE_MS,
  });

  // Phase 2b (VAULT_MCP_SEAMLESS=1, default OFF): route /mcp through the
  // MCP-semantic proxy so the tool surface flips 44↔17 mid-session via
  // tools/list_changed. Off → exact Phase 2a passthrough behavior.
  const SEAMLESS = ["1", "true", "yes", "on"].includes(
    (process.env.VAULT_MCP_SEAMLESS ?? "").trim().toLowerCase(),
  );
  const semantic = SEAMLESS
    ? createSemanticProxy({
        bridgePath: BRIDGE,
        presence,
        // Lazy FS discipline (launchd EBADF fix): the index/watcher only builds
        // when a session actually serves FS mode.
        fsReady: () => fsHandler.ready(),
      })
    : undefined;

  const app = buildFront({
    cfg,
    token: TOKEN,
    presence,
    fs: fsHandler,
    live: liveProxy,
    seamless: semantic,
    profiles,
    rateLimits: loadRateLimitConfig(),
    logWrite: createLogWriter(loadRequestLogConfig()),
    ...(process.env.VAULT_MCP_TRUST_PROXY !== undefined ? { trustProxy: parseTrustProxy(process.env.VAULT_MCP_TRUST_PROXY) } : {}),
  });

  presence.start();
  wireFailover({ presence, live: liveProxy, fs: fsHandler });

  // NOTE: the FS index/watcher is built lazily (on first FS-mode request, or
  // prewarmed by wireFailover on presence "down") — NOT at startup. A vault
  // watcher running during LIVE mode corrupts child_process fd setup under
  // launchd and EBADFs the bridge spawn, so FS machinery only runs in FS mode.

  app.listen(PORT, HOST, () => {
    console.error(
      `[front] listening on http://${HOST}:${PORT}/mcp — presence-aware (socket: ${socketPath})`,
    );
  });
}
