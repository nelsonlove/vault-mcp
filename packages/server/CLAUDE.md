# CLAUDE.md — obsidian-vault-mcp-server

> Auto-loaded by Claude Code as project context. Describes the current (Phase 2a)
> monorepo server package — NOT the retired NixOS/VPS architecture.

## What this package is

The **presence-aware HTTP front** for the vault-mcp remote endpoint, hosted on
the macbook-pro behind a cloudflared tunnel (`obsidian.nelson.love`).

It is a single Express process (`src/front.ts`) that:

- Routes `/mcp` to the **LIVE proxy** (plugin-backed, 44 tools) when Obsidian's
  plugin Unix socket (`~/.claude/vault-mcp/<slug>.sock`) is reachable.
- Falls back to the **FS handler** (`@vault-mcp/core`'s `FilesystemBackend`,
  20 tools: the 17 note tools and the three `.base`/`.canvas` file tools) when the socket is gone — no outage, graceful degradation.
- Returns to LIVE mode automatically when the plugin reconnects.

**FS watcher lifecycle (#583):** the FS index and its vault watcher run only in FS mode, because a watcher running in LIVE mode breaks child_process fd setup under launchd and every bridge spawn then fails with `EBADF`. `wireFailover` prewarms them only after presence has stayed down for `VAULT_MCP_FS_PREWARM_DELAY_MS` (default 10 s), and on "up" calls `fs.stop()`, which cancels a `ready()` still in flight (a generation counter in `createFsHandler`) and resolves only when no watcher is open. As a safety net, `createEbadfGuard` stops the watcher when a bridge spawn fails with `EBADF` while it runs in LIVE mode, logs that once, and counts it in `/health` (`bridgeSpawnEbadf`). Tests: `src/__tests__/fs-watcher-flap.test.ts`.

**FS-mode write caveat:** writes while Obsidian is closed are direct disk edits.
Obsidian Sync reconciles them on relaunch; they are canonical after that point.
Since issue #92 they are **serialized and journaled**: every FS-mode mutation
runs through a process-wide FIFO write queue and appends exactly one JSONL
record to the server-side journal (`src/fs-write-kernel.ts` — a lean,
server-local counterpart to the plugin kernel's WriteQueue/WriteJournal; this
package does not, and must not, depend on `packages/host`). Journal location:
`~/.claude/vault-mcp/journal/<vault-slug>/YYYY-MM.jsonl` (or under
`$VAULT_MCP_STATE_DIR`; override with `$VAULT_MCP_FS_JOURNAL_DIR`) — beside the
server's socket state, never inside the vault tree. Record shape matches the
plugin's `JournalRecord` field-for-field where meaningful (`ts`, `op`, `target`,
`actor`, `argsDigest`, `outcome: ok|error`, `error`, `durationMs`,
`queueWaitMs`, `revBefore`/`revAfter`), with `actor.server.mode:
"fs-fallback"` so the two streams stay jointly greppable; journal failures are
logged and swallowed, never failing the vault op; note bodies never land.

FS-mode writes remain **refused by default**, because queue+journal is not full
kernel parity: they still bypass the plugin kernel's governance surface
(`if_rev`, idempotency keys, advisory locks, pending review), and serialization
is in-process only — nothing serializes against a concurrently running Obsidian
or a second server process. A deployment opts in explicitly via
`VAULT_MCP_FS_ALLOW_WRITES=true` (`src/fs-mode.ts`'s
`isFsWritesEnabled`/`FsWritesDisabledError`), and `GET /health` reports the
current setting as `fsWritesEnabled`. A malformed or escaping path is refused in `mutate` before the FS kernel, typed `invalid_path` by `resolveInVault` over the op's `target` paths, unjournaled (#444); it runs before the op's own argument checks, so a bad path on `obsidian_delete_note` is reported before a missing `confirm`, and a bad path before a missing `.md`. Two refusals carry `Error [truncated_read]` on this transport (#441, #443): a `content` carrying the read trailer (a cut read handed back) is refused in `mutate` before the FS kernel, unjournaled; a whole-note overwrite of a note longer than the read limit is refused at dequeue, journaled, because its only proof here is the note's mtime and that must be compared where the write happens (`noteLength` resolves the path through `resolveInVault`, so a path outside the vault is never stat'ed for it). The road through the second: `obsidian_read_note` with `full: true` serves the note whole on this transport too, but no whole-note overwrite is let through here: its writes carry no `if_rev`, so nothing could tie a proof of a whole read to the caller (a per-process memory would let one client's whole read prove another client's overwrite); #446 — show the token on reads, accept it as the write's `if_rev` — is that road. The rule runs at dequeue (the length as the write meets it; a write queued ahead can push a note past the limit), journaled, with no proof standing it aside here; the cost in the critical section is a stat per overwrite, a read only above the limit in bytes. No read on this transport shows a `rev` (no `rev` hook is wired). Reads are never gated, never queued, and
never journaled.

## Auth (dual + per-user allowlist)

`src/auth.ts`'s `createAuthGate` accepts either:
- Static Bearer `VAULT_MCP_TOKEN` (Claude Code / API).
- Clerk OAuth opaque token (`oat_…`) validated via RFC 7662 introspection
  (`AUTH_INTROSPECTION_URL`) with client-binding (`AUTH_CLIENT_ID`/`SECRET`).

Startup is **fail-closed**: refuses to run without at least one auth method,
and with `AUTH_ENABLED=true` + no `AUTH_ALLOWED_SUBS`/`AUTH_ALLOWED_EMAILS`
(unless `AUTH_ALLOW_ANY_AUTHENTICATED=true`).

See `deploy/REMOTE.md` § 5 for the full env-var reference.

## Key modules

| File | Role |
| --- | --- |
| `src/front.ts` | Entrypoint + `buildFront` factory + `wireFailover` |
| `src/presence.ts` | `createPresenceMonitor` — socket-probe poll |
| `src/live-proxy.ts` | `createLiveProxy` — session factory (bridge.mjs per session) |
| `src/fs-mode.ts` | `createFsHandler` — stateless FS-mode request handler |
| `src/fs-write-kernel.ts` | issue #92: process-wide FS write queue + append-only JSONL write journal |
| `src/auth.ts` | `createAuthGate` + PRM / RFC 9728 helpers |
| `src/semantic-proxy.ts` | Phase 2b: MCP-semantic proxy — mid-session 44↔17 via `tools/list_changed`; enabled by `VAULT_MCP_SEAMLESS=1` (default OFF) |

## Deployment

LaunchAgent runs `node dist/front.js`. Tunnel: cloudflared remotely-managed
(no local config.yml). Full setup: `deploy/REMOTE.md`.

## Build / test

```bash
npm run build --workspace packages/server   # tsc → dist/
npm test --workspace packages/server        # tsc + node --test dist/__tests__/*.test.js
```
