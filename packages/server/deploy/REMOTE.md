# Remote plugin-backed mode (`obsidian.nelson.love` → macbook-pro)

This hosts `obsidian.nelson.love` on the macbook-pro. A single **presence-aware
front** (`front.ts`) routes every MCP call through the running Obsidian app when
it's live, and automatically falls back to the filesystem server when Obsidian is
closed — so the endpoint stays up across Obsidian restarts.

```
Claude Code / API  ──Authorization: Bearer <token>──►  https://obsidian.nelson.love/mcp
     │
Cloudflare edge   TLS (proxied CNAME → tunnel)
     │  outbound tunnel (no inbound ports on the mac)
cloudflared (LaunchAgent)  ──►  http://127.0.0.1:8787
     │
front.ts (LaunchAgent)  ── presence poll ──►  ~/.claude/vault-mcp/<vault>.sock
     │                                               │ unix socket (when Obsidian is live)
     ├─ Obsidian LIVE:  bridge.mjs ──► vault-mcp plugin ──► Obsidian APIs  (44 tools)
     └─ Obsidian DOWN:  FilesystemBackend (direct disk read/write)           (20 tools)
```

## Failover behavior

| Obsidian state | Mode | Tool surface | Notes |
| --- | --- | --- | --- |
| Running + plugin enabled | `live` | 44 tools (full `obsidian_*` set) | Writes go through Obsidian APIs — canonical, sync-safe, **journaled and serialized** by the plugin kernel |
| Closed / plugin disabled | `fs` | 20 tools (FS read + write) | Writes are direct disk edits; Obsidian Sync reconciles on relaunch. **Serialized in-process and journaled** (issue #92) to `~/.claude/vault-mcp/journal/<slug>/YYYY-MM.jsonl` via `fs-write-kernel.ts`, but they still bypass the plugin kernel's governance (`if_rev`, idempotency, locks, pending review) and cross-process serialization — so FS-mode writes are **refused** unless the deployment opts in via `VAULT_MCP_FS_ALLOW_WRITES=true`. Reads are never affected. |
| Reopened after closure | `live` | Back to 44 tools (auto) | Open SSE channels get a `notifications/tools/list_changed` push |

`GET /health` returns:

```json
{ "status": "ok", "mode": "live|fs", "authEnabled": true, "fsWriteSyncCaveat": true, "fsWritesEnabled": false, "bridgeSpawnEbadf": { "count": 0, "watcherStops": 0 } }
```

`mode` tells a monitor which surface is active. `fsWriteSyncCaveat` is always
`true`; it's a standing reminder that FS-mode writes are not Sync-committed until
Obsidian reopens. `fsWritesEnabled` reflects `VAULT_MCP_FS_ALLOW_WRITES` — `false`
(the default) means FS-mode writes are currently refused with
`Error [fs_writes_disabled]`; `true` means this deployment has explicitly opted
into FS-mode writes — which are serialized in-process and journaled
(server-side JSONL, see the table above), but carry none of the plugin
kernel's governance guarantees.

`bridgeSpawnEbadf` counts LIVE bridge spawns that failed with `EBADF` since the front started (`lastAt` is the time of the last one). A vault watcher left running in LIVE mode breaks child_process fd setup under launchd, so when such a spawn fails while the FS watcher runs in LIVE mode, the front stops the watcher (`watcherStops`) and logs one loud error the first time; the front keeps running (#583). A count that keeps rising with `watcherStops` at 0 means the cause is something else; a restart of the front may be needed.

The FS watcher only runs in FS mode. On presence "up" the front stops it, and that stop also cancels an index build or watcher start still in flight, so a short down and up (a plugin reload) leaves no watcher behind (#583).

## 1. Token + env

```bash
mkdir -p ~/.config/vault-mcp-remote ~/.local/state/vault-mcp-remote
umask 077
cat > ~/.config/vault-mcp-remote/env <<EOF
VAULT_MCP_TOKEN=$(openssl rand -hex 32)
PORT=8787
HOST=127.0.0.1
EOF
chmod 600 ~/.config/vault-mcp-remote/env
```

The token is the primary auth for Claude Code / API. Print it:
`grep VAULT_MCP_TOKEN ~/.config/vault-mcp-remote/env`.

## 2. Front service (LaunchAgent)

```bash
npm install && npm run build --workspace packages/server   # emits dist/front.js
cp deploy/com.nelson.vault-mcp-remote.plist.template \
   ~/Library/LaunchAgents/com.nelson.vault-mcp-remote.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nelson.vault-mcp-remote.plist
curl -s localhost:8787/health        # {"status":"ok","mode":"live"|"fs",...}
```

The plist should run `node dist/front.js` (not `dist/index.js` or
`dist/remote-proxy.js` — those files are retired).

## 3. Cloudflare tunnel (remotely-managed, token-based)

Uses a **remotely-managed** tunnel: config lives at Cloudflare, `cloudflared`
runs locally with just a token — no `cloudflared tunnel login`, no local
`config.yml`, no `sudo service install`.

1. **Create tunnel** `obsidian-vault` with `config_src: "cloudflare"`
   (`POST /accounts/<acct>/cfd_tunnel`), then fetch its **run token**
   (`GET …/cfd_tunnel/<id>/token`).
2. **Set ingress** (`PUT …/cfd_tunnel/<id>/configurations`):
   `obsidian.nelson.love → http://127.0.0.1:8787`, catch-all `http_status:404`.
3. **DNS:** point `obsidian.nelson.love` at a **proxied CNAME → `<id>.cfargotunnel.com`**.
4. **Store the token** and start the connector:
   ```bash
   umask 077
   printf '%s' '<RUN-TOKEN>' > ~/.config/vault-mcp-remote/tunnel-token
   chmod 600 ~/.config/vault-mcp-remote/tunnel-token
   cp deploy/com.nelson.cloudflared-obsidian.plist.template \
      ~/Library/LaunchAgents/com.nelson.cloudflared-obsidian.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nelson.cloudflared-obsidian.plist
   grep -i 'Registered tunnel connection' ~/.local/state/vault-mcp-remote/cloudflared.log
   ```

> **Ingress port must match** `PORT` in `~/.config/vault-mcp-remote/env` (default `8787`).
> It's set in the Cloudflare tunnel config (step 2), not locally.
>
> **Little Snitch:** add a permanent allow rule for `/opt/homebrew/bin/cloudflared`.
> Without it, headless tunnel connections are silently dropped under launchd.
>
> **Transient DNS note.** Sudden `i/o timeout` on Tailscale IPv6 resolver
> `fd7a:115c:a1e0::53` is a transient MagicDNS blip — it recovers on its own.

## 4. Connect a client

```bash
claude mcp add --transport http obsidian-remote https://obsidian.nelson.love/mcp \
  --header "Authorization: Bearer $(grep -oE '[0-9a-f]{64}' ~/.config/vault-mcp-remote/env)"
```

Claude Code and the Claude API send the static Bearer token. The claude.ai
**web app** is OAuth-only — use § 5 below.

## 5. claude.ai web (OAuth via Clerk) — as actually deployed

The front is **dual-auth**: static token *or* a Clerk OAuth token, plus a
**per-user allowlist**. It serves the RFC 9728 PRM at
`/.well-known/oauth-protected-resource` so claude.ai discovers the AS.
`src/auth.ts` is the resource-server half.

Two Clerk realities shaped the wiring:
- **Clerk issues opaque `oat_` tokens** (not JWTs — the per-app JWT toggle was
  unavailable), so tokens are validated by **RFC 7662 introspection**
  (`AUTH_INTROSPECTION_URL`), not JWKS. (If you flip the app to JWTs later,
  the JWKS path in `auth.ts` also works.)
- **DCR isn't enabled**, so claude.ai uses a **pre-registered** client (id +
  secret pasted into the connector's Advanced settings).

1. **Clerk** → Dashboard → **OAuth applications** → create a confidential app.
   Redirect URIs: `https://claude.ai/api/mcp/auth_callback` **and**
   `https://claude.com/api/mcp/auth_callback`. Note **client_id**, **client_secret**,
   **issuer**.
2. **Server env** — add to `~/.config/vault-mcp-remote/env`, restart the front LaunchAgent:
   ```
   AUTH_ENABLED=true
   MCP_RESOURCE_URL=https://obsidian.nelson.love/mcp
   AUTH_ISSUER=<Clerk issuer>
   AUTH_JWKS_URI=<Clerk issuer>/.well-known/jwks.json
   AUTH_SERVERS=<Clerk issuer>
   AUTH_SCOPES="openid profile email"
   AUTH_INTROSPECTION_URL=<Clerk issuer>/oauth/token_info
   AUTH_CLIENT_ID=<client_id>
   AUTH_CLIENT_SECRET=<client_secret>
   AUTH_ALLOWED_SUBS=user_xxxxxxxx
   ```
   Keep `VAULT_MCP_TOKEN` set so Claude Code/API still use the static token.
3. **claude.ai** → Settings → Connectors → add `https://obsidian.nelson.love/mcp`,
   paste **client_id + client_secret** in Advanced settings, complete Clerk login.
   The connector syncs to iOS.

## Config reference (`front.ts`)

| Env | Default | Meaning |
| --- | --- | --- |
| `VAULT_MCP_TOKEN` | *(required if no OAuth)* | static Bearer token (Claude Code/API) |
| `VAULT_MCP_SOCKET` | *(derived)* | absolute path to plugin Unix socket; overrides slug derivation |
| `VAULT_MCP_PRESENCE_POLL_MS` | `5000` | how often (ms) to probe the socket for Obsidian presence |
| `VAULT_MCP_FS_PREWARM_DELAY_MS` | `10000` | how long (ms) presence must stay down before the FS index and vault watcher are prewarmed (#583). A shorter down, such as a plugin reload, never starts them; an FS-mode request in the meantime still builds them on demand. `0` prewarms at once (the behaviour before #583); a value that is not a whole number falls back to the default with a warning |
| `VAULT_MCP_BRIDGE` | `~/.claude/vault-mcp/bridge.mjs` | plugin stdio bridge to spawn per LIVE session |
| `VAULT_MCP_IDLE_MS` | `1800000` (30 min) | idle-reap window for LIVE sessions |
| `VAULT_MCP_MAX_SESSIONS` | `32` | concurrent LIVE-backend cap |
| `VAULT_MCP_FS_ALLOW_WRITES` | `false` | opt into FS-mode writes (issue #92) — refused (`Error [fs_writes_disabled]`) unless this is set. Opted-in writes are serialized in-process and journaled, but bypass the plugin kernel's governance. Reads are unaffected either way |
| `VAULT_MCP_FS_JOURNAL_DIR` | `<state dir>/journal/<vault-slug>` | override the FS-write journal directory (issue #92); default sits beside the socket state under `~/.claude/vault-mcp/` or `$VAULT_MCP_STATE_DIR` |
| `VAULT_MCP_MESSAGE_URL` / `VAULT_MCP_MESSAGE_TOPIC` | — | turn on `vaultmcp_send_message` (FS mode): post short texts to this ntfy server and topic. Unset ⇒ the tool is not registered. Auth, tags and the hourly cap (`VAULT_MCP_MESSAGE_USER`, `_PASSWORD_FILE`, `_TOKEN_FILE`, `_TAGS`, `_RATE`): see "Message tool" in `packages/server/README.md` |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | local listen (tunnel target); keep on loopback |
| `AUTH_ENABLED` | `false` | enable the OAuth path + PRM discovery |
| `MCP_RESOURCE_URL` | — | PRM resource id + required JWT `aud` |
| `AUTH_ISSUER` / `AUTH_JWKS_URI` / `AUTH_SERVERS` / `AUTH_SCOPES` | — | AS wiring |
| `AUTH_INTROSPECTION_URL` | — | RFC 7662 endpoint for opaque tokens (Clerk `oat_`) |
| `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` | — | introspection auth + client-binding |
| `AUTH_ALLOWED_SUBS` / `AUTH_ALLOWED_EMAILS` | — | authorized users; required when `AUTH_ENABLED` |
| `AUTH_ALLOW_ANY_AUTHENTICATED` | `false` | opt out of allowlist requirement |
| `AUTH_SKIP_AUD_CHECK` | `false` | JWT path only: skip `aud` binding (leave OFF in production) |
| `VAULT_MCP_DEBUG_AUTH` | `false` | verbose auth diagnostics to stderr |
| `VAULT_STATE_DIR` / `VAULT_PATH` | — | override socket-path derivation (see `resolveSocketPath` in front.ts) |

> Startup is **fail-closed**: refuses to run with no auth at all, and with
> `AUTH_ENABLED=true` but no allowlist (unless `AUTH_ALLOW_ANY_AUTHENTICATED`).

## Phase 2b — seamless mid-session switching (flag-gated, default OFF)

`VAULT_MCP_SEAMLESS=1` routes `/mcp` through the **MCP-semantic proxy**
(`src/semantic-proxy.ts`) instead of the Phase 2a passthrough: each session gets
an in-process MCP server that mirrors the plugin's live tools (forwarding
`tools/call` over one shared bridge connection) or serves the 20 FS tools, and
on a presence flip emits `notifications/tools/list_changed` so a connected
client's tool surface changes 44↔17 **without reconnecting**. With the flag
unset the behavior is byte-for-byte Phase 2a.

Leave OFF until Phase 2a has a daily-use track record; flipping it on the
LaunchAgent is a deliberate operator step (add `VAULT_MCP_SEAMLESS=1` to
`~/.config/vault-mcp-remote/env`, `launchctl unload`/`load`). The semantic
proxy honors the lazy-FS discipline (no vault watcher in LIVE mode) and spawns
its bridge client with `stderr:"ignore"` (launchd EBADF fix).
