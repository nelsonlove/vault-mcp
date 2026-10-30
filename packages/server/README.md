# obsidian-vault-mcp-server

> Project hub: a project note in the operator's vault (for example `51001 obsidian-vault-mcp-server`; the id is made up)

A minimal **remote** (Streamable HTTP) MCP server that exposes an Obsidian vault
*folder* to Claude for reading, searching, and writing markdown. It operates
directly on the files that `obsidian-headless` keeps synced — it does **not**
talk to the Obsidian app or any plugin REST API, so there's no Electron and no
Xvfb.

> **Two modes.** The default (`npm start`, `index.ts`) is the filesystem server
> above. There is also a **plugin-backed remote mode** (`npm run start:proxy`,
> `remote-proxy.ts`) that fronts the in-Obsidian [`vault-mcp`](https://github.com/nelsonlove/obsidian-vault-mcp-plugin)
> plugin over the same Streamable-HTTP interface, so edits go **through
> Obsidian** (canonical, sync-safe) instead of straight to disk. Use it when
> hosting on a machine where the interactive Obsidian app is running (e.g. the
> macbook-pro behind `obsidian.nelson.love`). Setup: [`deploy/REMOTE.md`](deploy/REMOTE.md).

## Tools

| Tool | Purpose | Mutates? |
| --- | --- | --- |
| `obsidian_list_notes` | List notes (optionally under a subfolder), paginated | no |
| `obsidian_list_folders` | List immediate child folders + recursive note count per folder | no |
| `obsidian_read_note` | Read a note by vault-relative path | no |
| `obsidian_read_notes` | Bulk read by paths (up to 50/call); failed paths land in `errors[]` instead of failing the call | no |
| `obsidian_search_notes` | Case-insensitive full-text search; `mode: "one_per_note" \| "all"` for hit breadth vs depth | no |
| `obsidian_find_by_tag` | Find notes by frontmatter `tags:` or inline `#tag` | no |
| `obsidian_resolve` | Obsidian-faithful reference resolution: `[[wikilink]]`, basename, frontmatter alias, JD-ID (only when `VAULT_MCP_SCHEMES` names a Johnny Decimal scheme), or vault-relative path → canonical path. Handles `|alias`, `#heading`, `#^block`. Multiple matches → `ambiguous` with candidates | no |
| `obsidian_get_backlinks` | List notes that wikilink TO the given path | no |
| `obsidian_get_outlinks` | List `[[wikilinks]]` in the body of a note, each with resolved path when unambiguous | no |
| `obsidian_search_by_frontmatter` | Find notes whose frontmatter has `property == value` (case-insensitive property, exact value; array fields match any element) | no |
| `obsidian_manage_frontmatter` | Get / set / delete a single frontmatter field. Surgical line edits preserve other keys' formatting. Refuses block-scalar / inline-object shapes | yes (set/delete are destructive) |
| `obsidian_patch_note` | Anchor-based edit: insert/replace content relative to a heading section or `^block-id` paragraph. `previous` returned for undo/audit. A `replace` on an H1 anchor is refused (`h1_replace`) unless `whole_section: true` is passed: a heading's section runs to the next heading of equal or higher level, so the H1's section is the whole note | yes (destructive) |
| `obsidian_replace_text` | Replace one exact piece of text in a note (no regex), or every match with `all: true`; refused when found 0 times (`no_match`) or more than once without `all` (`many_matches`, with the count). A match may not touch a frontmatter fence, and the result goes through the same accept guard as `obsidian_write_note`. On a note longer than the read limit, a match past the limit is refused here (this server has no whole-read proof). Returns each changed span before and after | yes (destructive) |
| `obsidian_delete_note` | Permanently delete a note. Requires `confirm: true` literal in the call schema | yes (destructive — propagates via Sync) |
| `obsidian_move_note` | Move / rename a note. By default rewrites `[[wikilinks]]` that resolved to `from` so they now point at `to`, preserving each ref's visual shape | yes (destructive — multi-file mutation) |
| `obsidian_write_note` | Create / overwrite a note | yes (destructive) |
| `obsidian_append_note` | Append to (or create) a note | yes |
| `obsidian_write_file` | Create / overwrite an Obsidian Bases (`.base`, YAML) or JSON Canvas (`.canvas`) file. The content must parse as its type first (a YAML mapping; a JSON object whose `nodes` and `edges` are arrays of objects with unique ids), or it is refused with `invalid_file` and nothing is written. While `VAULT_MCP_WRITE_SCOPE` limits paths, a `.base` is refused (`base_under_scope`): a Base is a query | yes (destructive) |
| `obsidian_edit_file` | Change one keyed item of such a file: a Base view by `name`, a Canvas node or edge by `id` (upsert or remove; removing a node removes its edges). The result is validated as a whole write is | yes (destructive) |
| `obsidian_move_file` | Move / rename a `.base` or `.canvas` file, or an attachment whose extension is on `VAULT_MCP_FILE_MOVE_EXTENSIONS` (unset: images, audio, video, PDF, and docx xlsx pptx odt zip; empty: none), keeping its extension. A note (`.md`) is refused: `obsidian_move_note` moves notes. `overwrite: true` is refused for an attachment (`overwrite_refused`), so a move never destroys an existing file of that kind; a set variable with no valid entry means none. `obsidian_read_note` on a binary file returns `{path, size, binary: true}` and no content. This server does not rewrite links or embeds to it (its link index covers notes only); the response's `links_note` says so | yes (destructive) |
| `obsidian_force_reindex` | Rebuild the in-memory index synchronously. The watcher auto-refreshes within ~1.5s; call this only for tight read-after-write loops or suspected missed events | no (cache only) |
| `vaultmcp_send_message` | Send a short text (1 to 2,000 characters, at most 4,096 UTF-8 bytes) to the operator's ntfy topic. **Registered only when `VAULT_MCP_MESSAGE_URL` and `VAULT_MCP_MESSAGE_TOPIC` are set**; see "Message tool" below | no note changes; posts outside the vault |

All path-taking inputs (`path`, `paths`, `subdir`) are defensively
HTML-entity-decoded before resolution, so an agent passing `03 LLMs &amp; agents`
will hit the actual `03 LLMs & agents` folder. Covers `&amp; &lt; &gt; &quot; &apos;`
and numeric `&#NN;` / `&#xNN;` escapes.

## Run

```bash
npm install
npm run build
VAULT_PATH=/var/lib/obsidian/vault PORT=8787 HOST=127.0.0.1 npm start
```

Environment:

- `VAULT_PATH` — absolute path to the synced vault folder (default `./vault`)
- `PORT` — listen port (default `8787`)
- `HOST` — bind address (default `127.0.0.1`; keep it localhost behind your proxy)
- `VAULT_MCP_SCHEMES` — the addressing schemes, as a JSON list in the plugin's `schemes` shape (default: none). With none, no note gets a Johnny Decimal id and no ref resolves by one (`matched_by: "jd-id"`), as on a fresh plugin install. A `johnny-decimal` row turns JD ids on, with the 5-digit expansions in its `config`, for example `[{"id": "jd", "provider": "johnny-decimal", "config": {"expandedAreas": ["50-59"], "expandedCategories": ["34"]}}]` (made-up values; the provider's defaults expand nothing). A value that is not a JSON list, or that holds a row the plugin's scheme registry would skip, stops the index build

The MCP endpoint is `POST /mcp`. There's also `GET /health`.

## Security model (read this)

This server has **no authentication of its own** — that's deliberate, matching
Phase 1 of the deployment plan (HANDOFF.md):

- Bind to `127.0.0.1` and put TLS + access control in your reverse proxy (Caddy).
- Firewall the public edge so only Anthropic's egress range `160.79.104.0/21`
  can reach it. That blocks internet scanners but does **not** identify *which*
  Claude user is connecting.
- For per-user identity, add a real OAuth layer (DCR/CIMD) in front of or inside
  this process (Phase 2). Claude does **not** support user-pasted static bearer
  tokens, so a shared secret header is not a substitute.

Path safety: all filesystem access goes through `resolveInVault`, which refuses — typed `invalid_path` — a path that climbs out of the vault (`../x.md` is not folded back in; #444), an absolute path, a backslash, and a path into an ignored folder (`.obsidian`, `.trash`, `.git`, `node_modules`), and checks that no symlink leads outside `VAULT_PATH`.

## Remote front: connection profiles, rate limit, request log

The presence-aware front (`src/front.ts`, `npm start`) gates `/mcp` with the static bearer (`VAULT_MCP_TOKEN`) or OAuth 2.1 (`AUTH_*`). Since #521 it also decides, per credential, which tools the connection gets, limits the request rate, and writes a request log.

Where it runs: the Pro's Tailscale Funnel road serves the claude.ai connector; ChatGPT (typed and voice) is served from vaultd on Orange, per the ChatGPT plan (#524, #525). The per-connection profile is the same code on both.

### Connection profiles

A profile is an allowlist of tool names, defined in `@vault-mcp/core` (`packages/core/src/profile.ts`). A tool that is not on it is never registered: it is absent from `tools/list` and "not found" on call. A call-time check stays behind it. A new tool is outside every profile except `full` until it is added there.

| Profile | Tools |
| --- | --- |
| `full` | Every tool. What a local connection (the Claude Code bridge) gets, and what every credential gets when no mapping is set. |
| `read` | The 23 read tools in `READ_PROFILE_TOOLS` (reads, search, links, uids, tags, bookmarks, workspaces, snippets, command ids, plugin and environment info, `vaultmcp_conformance_debt`, `vaultmcp_bases_list`). No write, no command, no Code Mode meta-tool. |
| `read+inbox` | The `read` set plus `obsidian_write_note`, which may only create a new note directly inside a `.01` slot folder (`XX.01` or `XX.01 <name>`, at any depth). An overwrite, an existing note, a missing folder and every other write are refused (`write_scope`). This connection-level scope is checked on top of the vault-wide write scope, never instead of it. |
| `read+message` | A narrower read set (15 tools: the note, search, link, tag and Base-list reads; no machine state, app settings, bookmarks, snippets or command lists) plus `vaultmcp_send_message`, which posts a short text to a message service the operator configured (the tool is offered only where it is configured). No note can be written. |

#### Secret scanner (off by default)

The secret scanner (`@vault-mcp/core`, `packages/core/src/secret-scan.ts`) blanks key- and token-shaped strings in tool replies. It is OFF unless a deployment names the connection profiles to scan; no profile turns it on in code. On such a connection every tool reply passes through it before it is sent: the text of each content item, and every key and string in structured content. Tool arguments and anything written to disk are not changed.

How to turn it on:

- FS mode (this server): `VAULT_MCP_REDACT_PROFILES` names the profiles, as a JSON array (`["read+message"]`) or a comma list. `VAULT_MCP_REDACT_CONFIG` is the path of an optional JSON config file: a regular file (not a symbolic link), at most 1 MB. The file is read once; a change takes effect on a restart. The front logs a warning at start-up that these variables cover FS mode only.
- LIVE mode (the Obsidian plugin): the settings "Secret scanner: profiles" (`redactProfiles`) and "Secret scanner: config" (`redactConfig`, the same JSON as text), read when a connection is built. The front's environment does not reach the plugin, so set both places for a profile that may be served in either mode.

The config (all fields optional): `keyNames` replaces the shipped secret key names and `extraKeyNames` adds to them (words joined by a space, `_` or `-`; a name of 3 characters or fewer needs a word boundary before it); `patterns` replaces the shipped provider token shapes and `extraPatterns` adds to them, each `{"kind": "my-token", "regex": "…", "ignoreCase": false}`. The structural rules (private key blocks, JWTs, Authorization and bearer values, URL credentials) always run. A `keyNames` list replaces every shipped name, so a short or unusual list scans few keys in practice; nothing checks that for you. A pattern you add is run as given, anchored at the start of a token run; a pattern with nested repeats can make the scan slow.

```json
{ "extraKeyNames": ["licence code"], "extraPatterns": [{ "kind": "acme-token", "regex": "acme_[A-Za-z0-9]{32}" }] }
```

Fail closed: an unknown profile name, a config file that cannot be read or parsed, or a config the scanner refuses (an unknown field, a regex that does not compile or can match an empty span such as `\b` or `a{0}`, an empty `keyNames` or `patterns`) never leaves a listed profile unscanned. The front refuses to start, and a FS server built with such settings throws. The plugin logs the reason and, while a profile is listed, builds no tools for any remote connection (and for a local one when `full` is listed) until the settings are fixed. It reads the parsed list (a line may be a comma list or a JSON array). A list it cannot parse, a name in it that is not a known profile, or a setting of the wrong type in a hand-edited data.json refuses every connection, local ones included. A bad config with no profile listed changes nothing.

What the shipped defaults do:

- What it blanks: common key and token shapes (`sk-…`, `sk-ant-…`, `ghp_…`/`gho_…`/`github_pat_…`, GitLab `glpat-…`, Slack `xox[abposre]-…` and `xapp-…`, Hugging Face `hf_…`, npm `npm_…`, Tailscale `tskey-…`, SendGrid `SG.…`, `AKIA…`/`ASIA…`, `AIza…`, Stripe secret and restricted keys, JWTs, PEM and PGP private key blocks), `Authorization` header values and bearer tokens, the `user:pass` part of a URL (scheme and host are kept), and the value under a key that names a secret: password, passwd, pass, pw, pwd, passcode, passphrase, secret, token, cookie, credentials, API key, access, private, secret, session or client key, and the like (any case; words joined by a space, `_`, `-` or nothing; a trailing `pem` or `value` is allowed, as in `privateKeyPem`). A bare `pin` is not a key.
- Where it finds that value in text: after `:`, `：`, `=`, `=>`, ` - ` or a tab (quoted or not, the key bold, italic or in backticks, the colon inside or outside the markup); a value that opens with `[` or `{` is blanked to its matching close, over several lines if needed (past 1 MB, or with no close, to the end of its block); in a markdown table, with or without outer pipes (the cell after a key cell, and every body cell in a column whose header names a secret; an escaped `\|`, as in an alias wikilink, is not a cell boundary); inside blockquotes and callouts too; in a YAML block scalar or list below the key; in an XML element (`<password>x</password>`); and in an HTML pair (`name="password" value="x"`). No value is capped, so no tail is sent.
- JSON replies stay JSON: text that parses as JSON is parsed, scanned key-aware and written back in the same layout. The whole value under a secret-named key is blanked whatever its type (string, number, list or object), a key that is itself a token is blanked, and every other string is scanned as text. Structured content is scanned the same way; values that are not plain objects (a Date, a Map) are kept as they are, and so are `__proto__` keys. JSON with nothing to blank is sent byte for byte.
- Search snippets: `obsidian_search_notes` returns single matched lines, trimmed, so a line's key is often out of view. In its replies a snippet that looks like a secret body is blanked as well: a line of only base64 or hex of 24 or more characters (a PEM or PGP body line), a short base64 tail (`…==`) or a PGP checksum line (`=AbCd`), a one-token line or list item, and, in a table row (with or without outer pipes), each cell that holds one secret-looking token. A snippet from a blockquote or callout gets the same rules after its `>` markers. A secret-looking token has 6 or more characters, no spaces, a digit or an inner symbol, and is not an email, URL, path, link, tag, file name, hyphenated word, or a plain number, date, time or version.
- What it never blanks on its own: a long or random-looking string. Uids, uuids, hashes and commit shas pass (outside search snippets, where a line of only hex is blanked). Booleans, null and empty values under a secret key pass too (`secret: true`, `has_secret: false`), and so do keys that only contain the word (`tokens`, `max_tokens`, `passed`, `bypass`).
- The replacement is a fixed marker, `[redacted:<kind>]`; no part of the secret is kept.
- It is linear in its input and never throws. On an internal error it sends `[redacted:scan-failed]` in place of the text (fail closed).
- It is a best-effort filter. It cannot catch every form: a bare password in prose, a key split from its value, or an encoded secret passes through. Search results carry single lines, so a secret line whose key is out of view and whose shape is not one of the above (a table row without its header, a short or all-letter list item) is sent as it is. And a search, or `obsidian_search_by_frontmatter`, can confirm a guessed value: a hit tells the caller that the text it searched for is in the vault, blanked or not. Keep secrets out of the folders a hosted assistant can read.

`VAULT_MCP_PROFILES` maps a credential id to a profile, as JSON. A credential id names a credential without carrying it, so no secret is in the value: `token` is the static bearer, `sub:<subject>` an OAuth subject.

```bash
VAULT_MCP_PROFILES='{"token":"full","sub:user_2abc":"read"}'
```

- Unset or empty: every authenticated request gets `full` (the behaviour before profiles).
- Set: a credential with no entry is refused with 403.
- A value that does not parse, a key that is not `token` or `sub:…`, or an unknown profile name: the front refuses to start.

How the profile travels: the front gives each spawned bridge `VAULT_MCP_PROFILE` (set per session, never copied from the front's own environment; `full` sends nothing). The bridge sends it in the connection preamble, only to a plugin whose discovery file advertises the `profile` capability; against an older plugin it refuses to connect, at start and on reconnect. The plugin builds the connection's server from it (`buildMcpServer`'s `profile` option, filtered at `origRegister`, which every registration path ends in, satellites included). An unknown name builds no tools. Under a profile, Code Mode is ignored: the connection gets the plain, filtered surface. A session id opened under one profile answers as unknown under another. FS mode applies the same filter in `registerFsTools`.

### Paths from `MCP_RESOURCE_URL`

The endpoint answers on `/mcp` and on the path of `MCP_RESOURCE_URL` (for `https://host/vault-mcp/mcp`, also `/vault-mcp/mcp`), so a `tailscale serve --set-path` mount works whether or not it strips its prefix. The protected-resource metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource`, its `/mcp` suffix, the resource path's suffix (`/.well-known/oauth-protected-resource/vault-mcp/mcp`), and each of those under the mount. The `WWW-Authenticate` `resource_metadata` URL is the RFC 9728 form for the resource URL.

### Rate limit

A fixed window per minute, in memory. A refused request gets 429 with `Retry-After`.

- `VAULT_MCP_RATE_IP_PER_MIN` (default 300): per client IP, checked before auth.
- `VAULT_MCP_RATE_CRED_PER_MIN` (default 120): per credential id, checked after auth.
- `0` turns a limit off.
- `VAULT_MCP_TRUST_PROXY` (default `loopback`): Express's "trust proxy", which decides who may name the client IP in `X-Forwarded-For`. The default trusts only a loopback peer (tailscale serve, cloudflared).
- `VAULT_MCP_PRM_UNDER_RESOURCE` (default off): serve the OAuth protected-resource metadata inside the resource's own path, `<MCP_RESOURCE_URL>/.well-known/oauth-protected-resource`, and name that URL in the 401's `resource_metadata`. Set it when a proxy publishes only one path (Funnel at `/mcp`), so a client finds the metadata without a second path at the host root. RFC 9728 §5.1 lets the header name any metadata URL, and the MCP clients that follow the spec use the header first. It needs `MCP_RESOURCE_URL`.

### Request log

One JSON line per `/mcp` request, refusals included: `time`, `ip`, `credential` (the credential id, never the token), `profile`, `http` (the verb), `rpc` (the JSON-RPC method), `tool` (the tool name of a `tools/call`), `status`, `ms`. No note content and no arguments are written.

- `VAULT_MCP_REQUEST_LOG`: the file, or `off`. Default: `$XDG_STATE_HOME/vault-mcp-remote/requests.jsonl` (`~/.local/state/vault-mcp-remote/requests.jsonl`).
- `VAULT_MCP_REQUEST_LOG_MAX_BYTES` (default 10 MB): at the cap the file rotates to `.1`, `.2`, `.3`; three are kept.

### Message tool

`vaultmcp_send_message` lets a connected client send a short text to whoever reads an [ntfy](https://docs.ntfy.sh/publish/) topic. It is off by default: with no URL or no topic set, the tool is not registered and `tools/list` does not show it. It is not a vault write (no note changes, no `if_rev`). Its code is `packages/core/src/send-message.ts`. FS mode only: the Obsidian plugin does not offer it.

Arguments: `text` (1 to 2,000 characters and at most 4,096 bytes in UTF-8, which is ntfy's message limit; a longer text is refused with `text_too_long`, never cut), `title` (optional, at most 200 characters, one line), `idempotency_key` (optional; a retry with the same key and text within an hour returns the first result and posts nothing; the same key with other text is refused with `idempotency_conflict`). If the first send with a key ends in `message_network`, ntfy may or may not have the message: for the rest of that hour a retry with the same key is refused with `idempotency_unknown` and posts nothing. To send again, use a new key. It returns `{ "sent": true, "id": "<ntfy message id>" }`.

| Env | Default | Meaning |
| --- | --- | --- |
| `VAULT_MCP_MESSAGE_URL` | — | the ntfy server, such as `https://ntfy.example.test`. Must be https; http is allowed only for `localhost`, `127.0.0.1` and `[::1]` |
| `VAULT_MCP_MESSAGE_TOPIC` | — | the topic, such as `inbox` (1 to 64 letters, digits, `-`, `_`) |
| `VAULT_MCP_MESSAGE_USER` + `VAULT_MCP_MESSAGE_PASSWORD_FILE` | — | HTTP Basic auth. The password is read from the file at each call, never logged and never returned |
| `VAULT_MCP_MESSAGE_TOKEN_FILE` | — | a bearer token in a file, printable ASCII; the alternative to user and password (set one or the other) |
| `VAULT_MCP_MESSAGE_TAGS` | — | ntfy tags for every message, as a comma list; each tag is printable ASCII |
| `VAULT_MCP_MESSAGE_RATE` | `10` | the most sends in any one hour, per process (a sliding window) |

A password or token file that its group or other users can access (any mode bit in `077`) is refused; use mode `600`. A symlink is refused too: point the variable at the file itself. The file is opened once, and the mode check and the read use that one handle. The front's profiles decide who sees the tool: it is outside `read` and `read+inbox`, so today only `full` connections get it.

Errors, each `Error [code]: …` and none of them naming a credential: `text_too_long`, `title_too_long`, `invalid_argument`, `message_config` (a bad value, a non-ASCII tag or token, or an unreadable, open or symlinked secret file; checked before a rate slot is used), `rate_limited` (names the time the next send is allowed), `message_http` (the server answered non-2xx; names the status), `message_network` (the server was not reached or timed out after 10 s), `idempotency_conflict`, `idempotency_unknown`. In every case but `message_network` nothing was sent; after `message_network` it is unknown whether ntfy received the message.

```bash
VAULT_MCP_MESSAGE_URL=https://ntfy.example.test
VAULT_MCP_MESSAGE_TOPIC=inbox
VAULT_MCP_MESSAGE_USER=assistant
VAULT_MCP_MESSAGE_PASSWORD_FILE=/etc/example/ntfy-password
VAULT_MCP_MESSAGE_TAGS=robot
```

## Notes / limitations

- Search returns **one matching line per note** to keep results broad and the
  payload small; change the `break` in `searchNotes` for all-line matches.
- Tag extraction is lightweight (no YAML dependency). For robust frontmatter
  parsing, swap in `gray-matter`.
- Stateless transport: a fresh server+transport is built per POST, which avoids
  request-id collisions and scales trivially for single-user use.
- Large notes are truncated at `CHARACTER_LIMIT` (100k chars) on read; `obsidian_read_note` with `full: true` returns one whole (the whole-note write policy still applies on this server: #443, #446).

## Deployment walkthrough (Vultr + UTM NixOS jump host)

This is the path that actually worked. `HANDOFF.md` has the canonical phased
plan; this is the practical sequence as deployed in the first end-to-end run.
For the reasoning behind specific decisions and a chronological log of fixes,
see the project journal in the vault: `93046.10 Requirements & design/Deployment journal`.

### Prerequisites

- **Cloud VPS** with KVM/virtio (Vultr Cloud Compute confirmed, others should work).
  Cheapest tier (~$3-6/mo) — anything ≥ 1 GiB RAM. BIOS or UEFI both OK; flake
  is currently configured for BIOS+GRUB (`nix/hosts/cloud-disk.nix`).
- **A domain** with DNS managed somewhere you can add A records. The flake
  currently hardcodes `obsidian.nelson.love` in `nix/modules/host.nix:8`.
- **A Linux machine with Nix** to run `nixos-anywhere` from. The Mac can be
  this directly (DeterminateSystems installer) or via a UTM NixOS VM. macOS
  binfmt-emulating x86 builds crash on Go binaries (Caddy) — use
  `--build-on-remote` always.

### 1. Provision the VPS

- Create a Vultr Cloud Compute instance, any OS image (it'll be wiped). Note the IP.
- **Attach the NixOS x86_64 minimal ISO** via Vultr panel → Settings → Custom ISO.
- Reboot. Boot from ISO. In Vultr's web console, run `passwd` to set a throwaway
  root password (the NixOS live ISO has no password by default and sshd refuses
  empty-password logins).

### 2. DNS

- A record: `<your-subdomain>` → `<vps-ip>`
- **Cloudflare:** set to **DNS only (gray cloud)**, not proxied. Caddy's HTTP-01
  ACME challenge needs to reach the origin directly on port 80. Orange cloud
  breaks the cert flow. (You can flip to orange later if you switch Caddy to
  DNS-01 challenge with a Cloudflare API token.)

### 3. Edit the flake for your deploy

Three placeholders before the first deploy:

- `nix/hosts/cloud.nix:13` — root SSH public key. **The key in the flake belongs
  to Nelson** — replace with yours.
- `nix/modules/host.nix:8` — `domain = "obsidian.nelson.love";` — replace with
  your subdomain.
- `nix/hosts/cloud-disk.nix:13` — `device = "/dev/vda";` — Vultr default. Hetzner
  uses `/dev/sda`. Confirm with `lsblk` if uncertain.

Commit + push.

### 4. Run nixos-anywhere

From your Linux Nix host (e.g., UTM VM), with a GitHub PAT in scope for fetching
the private flake:

```bash
NIX_CONFIG="access-tokens = github.com=ghp_YOUR_TOKEN" \
  nix run github:nix-community/nixos-anywhere -- \
    --flake github:<owner>/obsidian-vault-mcp-server/<commit>#cloud \
    --build-on-remote \
    root@<vps-ip>
```

**You will likely hit the swap OOM.** See the [Deployment caveats](#deployment-caveats-vultr-small-tier-kvm)
section below — when `nix-daemon disconnected unexpectedly` shows up, ssh to
the box, add an 8 GB swap file to `/mnt`, then resume with `--phases install,reboot`.

After `### Done! ###`:

- **Vultr panel → Settings → Custom ISO → detach the ISO** before the box reboots
  into the installed system. Otherwise it'll boot the ISO again and you'll be
  back at the start.
- Reboot from the Vultr panel.

### 5. Verify the install

From your Mac:

```bash
ssh-keygen -R <vps-ip>     # host key changed during install
ssh root@<vps-ip>          # should be key-based, no password
```

Inside:

```bash
systemctl status caddy vault-mcp obsidian-sync
# expected: caddy + vault-mcp active; obsidian-sync failing (pre-ob-login, fine)
curl -sS http://127.0.0.1:8787/health
# {"status":"ok","vault":"/var/lib/obsidian/vault","authEnabled":false}
```

DNS + Caddy ACME (port 80 from anywhere is open by default):

```bash
journalctl -u caddy | tail -30
# look for "certificate obtained successfully"
curl -sS https://<your-domain>/health     # from your Mac, BEFORE the firewall lock kicks in fully
```

Confirm the nftables firewall rule landed:

```bash
nft list ruleset | grep -A 2 'tcp dport 443'
# expect:
#   ip saddr 160.79.104.0/21 tcp dport 443 accept
#   tcp dport 443 drop
```

And from your Mac — `https://<your-domain>/mcp` should **now time out** (only
Anthropic egress can reach it). That confirms Phase 1 lockdown is in effect.

### 6. Bootstrap Obsidian Sync (`ob login` — interactive)

The `obsidian-sync` service is a chicken-and-egg case: it expects
`/var/lib/obsidian/vault` to exist but that dir is only created after first
`ob sync-setup`. Bootstrap manually:

```bash
systemctl stop obsidian-sync

sudo -u vault bash -i
cd /var/lib/obsidian/vault          # critical: be in this exact dir, not the parent
# pre-install the obsidian-headless package the service will use:
npm install --prefix /var/lib/obsidian/obsidian-headless \
  --no-fund --no-audit obsidian-headless@0.0.10
mkdir -p /var/lib/obsidian/vault

/var/lib/obsidian/obsidian-headless/node_modules/.bin/ob login            # email + pw + MFA + E2E password
/var/lib/obsidian/obsidian-headless/node_modules/.bin/ob sync-list-remote # confirm vault appears
# IMPORTANT: copy the EXACT vault name from sync-list-remote output
/var/lib/obsidian/obsidian-headless/node_modules/.bin/ob sync-setup --vault "<exact name>"

exit
systemctl start obsidian-sync
journalctl -u obsidian-sync -f
```

**Critical gotcha:** the cwd when you run `ob sync-setup` is the local root
that gets associated with the vault. If you run it from `/var/lib/obsidian`
(the vault user's HOME) instead of `/var/lib/obsidian/vault`, Sync will treat
everything under `/var/lib/obsidian` as part of the vault and push the
contents (including the npm-installed `obsidian-headless/` directory)
upstream to your Mac and iPhone. **Run from inside `/var/lib/obsidian/vault`.**

### 7. Add the connector in claude.ai

- claude.ai desktop browser → Settings → Connectors → Add custom connector
- URL: `https://<your-domain>/mcp`
- Auth: none (Phase 1)
- Save — all 21 tools appear in the per-tool permission list. Set each to
  Allow / Ask / Deny to taste.
- Open Claude on iOS — connector syncs automatically (you can't add from iOS,
  only use)

#### Lazy tool loading in claude.ai sessions

claude.ai uses **deferred tool loading** for connectors with broad surfaces:
the model doesn't materialize every tool into its working context at session
start. When you ask a fresh session *"what obsidian tools do you have?"* it
will run a tool search and return whatever subset the search ranks highest —
often 5–7, not all 20 — and report that as its complete inventory. This is
**not a server bug** and not a destructive-tool filter; the connector still
advertises all 20 in `tools/list`.

The model loads tool schemas on demand. To work around the partial
enumeration:

- Name a tool by ID (`"use obsidian_delete_note to..."`) — the client
  lazy-loads its schema and the model can call it.
- Ask the session broadly upfront (`"load every obsidian tool — read AND
  write"`) — that drives a wider tool search and pulls in the full set.
- Describe the capability ("how do I move a note?") — nudges the model
  toward the right tool name even when its top-K search missed it.

If a fresh session reports a partial list, that's the explanation; reach for
the prompts above, not a redeploy.

Done. Phase 4 (real OAuth) is documented in `vault-mcp-oauth-phase2.md`.

## Deployment caveats (Vultr small-tier KVM)

- **disko swap partition isn't activated at install time on the pinned disko
  rev** (`115e5211...`, set in `flake.lock`). The `swap = { content.type =
  "swap"; }` declaration in `nix/hosts/cloud-disk.nix` creates the partition
  but `swapon` doesn't run during the install phase. On a low-RAM Vultr tier
  (~1.9 GiB), `nixos-anywhere` will OOM-kill `nix-daemon` mid-`### Building
  the system closure ###` and bail with `Nix daemon disconnected unexpectedly`.
- **Workaround:** SSH to the box mid-install, add an 8 GB swap file to `/mnt`,
  then resume with `--phases install,reboot`:
  ```bash
  # on the box, after disko has mounted /mnt:
  dd if=/dev/zero of=/mnt/swapfile bs=1M count=8192 status=progress
  chmod 600 /mnt/swapfile && mkswap /mnt/swapfile && swapon /mnt/swapfile

  # then re-run nixos-anywhere with --phases install,reboot
  ```
- **Possible fix to investigate later:** the disko partition may need an
  explicit `priority` or `discardPolicy` option to trip the install-time
  `swapon`, or upgrading the disko input may resolve it. If you upgrade
  disko via `nix flake update`, drop this workaround.

## Wiring into the deployment

In the NixOS `vault-mcp` systemd service (`nix/modules/services.nix`), the
package's launcher is invoked directly and the env is set on the unit:

```nix
environment = {
  VAULT_PATH = "/var/lib/obsidian/vault";
  PORT = "8787";
  HOST = "127.0.0.1";
};
ExecStart = "${vault-mcp}/bin/vault-mcp";
```
