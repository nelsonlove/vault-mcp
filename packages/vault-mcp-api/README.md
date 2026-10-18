# vault-mcp-api

Publisher SDK for the [vault-mcp](https://github.com/nelsonlove/vault-mcp) host's external tool registry: let your Obsidian plugin publish MCP tools to Claude Code through the vault-mcp bridge.

> **Canonical home:** this package lives in the suite monorepo at `packages/vault-mcp-api` of [nelsonlove/vault-mcp](https://github.com/nelsonlove/vault-mcp) (the repository was `obsidian-governor` until 2026-09-22 and `obsidian-mcp-suite` until 2026-10-08; the old names redirect), next to the host side of the contract (`packages/host/src/mcp/external-tools.ts`) and a contract test that pins the two together. The old standalone repo ([nelsonlove/vault-mcp-api](https://github.com/nelsonlove/vault-mcp-api)) is archived; existing `github:nelsonlove/vault-mcp-api#v1.0.0` installs keep working from the archive. The published npm package name is unchanged.

> **The host's plugin id moved twice; this package did not.** It was `vault-mcp`, became `governor` at 0.12.0, and became `vault-mcp` again at the host/provider split, when `governor` started to mean the optional acceptance-perimeter plugin that plugs into the host. The npm package name stays `vault-mcp-api`: it is a published contract, and renaming it would strand consumers for no user-visible gain. The SDK is **dual-id**: it looks the host up under `vault-mcp` first and then `governor` (skipping a `governor` plugin that exposes no api), and it waits on both `vault-mcp:ready` and `governor:ready`. One SDK build therefore works against a host on either side of either migration.

## Install

    npm install vault-mcp-api

(Until the first monorepo-published version reaches npm, the pinned install from the old repo still works: `npm install github:nelsonlove/vault-mcp-api#v1.0.0`.)

`obsidian` and `zod` are peer dependencies (any plugin build already has the former; npm ≥7 auto-installs the latter).

## Use

    import { publishTools } from "vault-mcp-api";
    import { z } from "zod";

    // in your plugin's onload():
    this.register(
      publishTools(this, [{
        name: "my_tool",                 // published as <your-plugin-id>_my_tool
        description: "What it does.",
        inputSchema: { arg: z.string().describe("…") },  // or plain JSON Schema
        readOnly: false,                 // omit/false ⇒ blocked in Governor's read-only mode
        handler: async ({ arg }) => ({ result: "plain JSON out" }),
      }])
    );

Rules: tool `name` must match `/^[a-z][a-z0-9_]*$/`; published tool names must not collide with Governor's built-in `obsidian_*` namespace (registration throws a TypeError if the namespaced name would start with `obsidian_`). Handlers return plain JSON-serializable values (Governor wraps them) and thrown errors become MCP tool errors; tools appear to Claude Code sessions on their next connect. Requires a host whose `apiVersion` is at least 1 (at least 3 for a tool that carries write declarations, below) — the number is a floor, not an exact match, so a newer host is accepted and its extra members are detected by presence; a host below the floor (or with no version) gets a console warning and nothing is registered.

## Building against this package inside the monorepo

Dependents resolve `dist/index.js` through the workspace link, and `dist/` is not committed: `npm install` builds it (`prepare`), and every dependent's `prebuild` rebuilds it, so a satellite bundle can never carry a stale SDK. That is the whole of step A′ of the apiVersion 2 sequence: rebuild, no code change.

## Partial results (SDK 1.1, host apiVersion 2)

A handler that did part of its work returns `partial(data, message)` instead of throwing: the caller gets `data` AND the error bit. On a host at apiVersion 2 or later the result lands as `structuredContent = data`, `content` as the coded message line (`Error [partial]: <message>`) and then the JSON text, and `isError: true`; the host records the operation's outcome as `partial`, not refused. A thrown error stays text-only, as today. On a host before apiVersion 2 the branded object was wrapped as an ordinary result with the brand key (`vault-mcp-api/envelope`) visible: degraded, not broken. The brand is checked only on the top-level return value; a `partial` nested inside `data` is data.

    import { partial } from "vault-mcp-api";
    handler: async ({ paths }) => {
      const done = [], failed = [];
      // …
      return failed.length ? partial({ done }, `${failed.length} note(s) unreadable: ${failed.join(", ")}`) : { done };
    }

## Caller context (SDK 1.1, host apiVersion 2)

From apiVersion 2 the host passes a per-call `CallContext` as the handler's second argument: `visible(paths)` returns the subset this caller may see (the same array when no allowlist is active), `isVisible(path)` answers for one path, and `readOnly` says the session cannot write. The allowlist itself is never handed over. A v1 host passes nothing; treat absence as "cannot tell" and keep whatever filtering you do today, never as "everything is visible". What the context does not lift: a tool with no path argument under an active allowlist is still refused wholesale by the host; the context re-lights the row filters of the calls that get through.

    handler: async ({ folder }, ctx) => {
      const rows = await listRows(folder);                       // [{ path, ... }]
      // A v2 host answers per path. A v1 host passes no ctx: "cannot tell", so the
      // filter you apply TODAY stays in place — never `rows` unfiltered.
      const shown = ctx ? new Set(ctx.visible(rows.map((r) => r.path))) : myOwnVisibilityToday(rows);
      return { rows: rows.filter((r) => shown.has(r.path)) };
    }

## Write declarations (SDK 1.2, host apiVersion 3)

A host tool's write protection and its place in the Sync guard are listed in the host's own tables, by tool name. A published tool has no row there, so a host before apiVersion 3 checks none of it for your tools. From apiVersion 3 a spec declares three things, and the host enforces each exactly as for one of its own tools:

- `protection`: what a call must carry (01.33 rule 6f). `"token"` requires `if_rev` (the write changes content the caller read), `"key"` requires `idempotency_key` (the write is not naturally idempotent), `"both"`, or `"exempt"`. It may depend on one argument: `{ arg: "dry_run", values: { true: "exempt" }, otherwise: "key" }` (booleans as `"true"`/`"false"`; `otherwise` covers every other value and the argument's absence). A call that omits what its class requires is refused `Error [protection_required]` before it runs; a keyed call is journaled and replayed on a retry like a host write.
- `sync`: `{ kind, strictStatus?, destinationUnnamed? }`. `kind` is `"structure"` (a rename, move, delete or create: it waits for Obsidian Sync, then is refused `sync_behind` if Sync is still behind) or `"content"` (an edit or append: it waits, then goes on with a warning), or argument-dependent in the same `{ arg, values, otherwise }` form. `strictStatus: true` puts it on the strict list: a rename, move or delete that also waits (up to the host's `strictWaitSeconds`, 120 s by default) for "Fully synced". `destinationUnnamed: true` puts it on the destination-unnamed list: the tool does not name where it writes, so a server change waiting anywhere in the vault counts. Both apply to a structure write only.
- `paths`: the argument names that carry vault paths. Each must be a key the host's path walk recognizes (`path`, `from`, `to`, `target_path`, `template_path`, `subdir`, `file_path`, `output_folder`, `note_path`, `paths`, `refs`), because the record guard, the lock consult, the journal target, the Sync guard's targets and the allowlist all read paths by that walk. Under a path allowlist each call is then checked per path, and refused when none of the declared arguments carries one.

For example, a tool that moves a note to a computed address:

    publishTools(this, [{
      name: "assign_address",
      description: "Move a note to the next free address in its scope.",
      inputSchema: { path: z.string(), dry_run: z.boolean().optional() },
      protection: { arg: "dry_run", values: { true: "exempt" }, otherwise: "key" },
      sync: { kind: "structure", strictStatus: true, destinationUnnamed: true },
      paths: ["path"],
      handler: async ({ path, dry_run }) => ({ moved: path }),
    }]);

A spec that declares none of the three is an apiVersion-2 spec and behaves exactly as before. The host refuses a malformed declaration at registration, and registers nothing from that call: an unknown key (a misspelt `strictStatus` would otherwise be silently off), a class or kind outside the closed set, an argument the tool's `inputSchema` does not declare or that is a kernel argument (`if_rev`, `idempotency_key`, `intent`), a path argument the walk does not recognize, a path listed twice, the two Sync lists on a content-only tool, `protection` or `sync` on a tool that claims `readOnly`, and a mutating tool that declares `sync` or `paths` but no `protection`. A host's own tables always win: a declaration rules only a tool the host does not know.

On a host below apiVersion 3 the SDK fails closed: a tool that declares any of the three is left out, with one console warning naming it, because that host would run it with none of the protection it asked for. The other tools register as before. `API_VERSION_DECLARATIONS` (3) is the level, and `declaresWrites(spec)` and `specsForHost(api, specs)` are exported for your own tests.
