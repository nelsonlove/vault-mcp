# Scope provider — `jd:` addressing

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


The scope provider is a [capability module](module-system.md) (id `scheme`, capabilities
`["addressing", "allocation"]`) that gives an agent a **scheme-relative** way to name and place
notes. The default configured scheme is **Johnny Decimal**, addressed `jd:`.

Files: `packages/host/src/mcp/tools-scheme.ts` (five read tools), `packages/host/src/mcp/tools-scheme-write.ts`
(three write tools), `packages/host/src/kernel/scheme/` (the pure engine: `registry.ts`, `jd.ts`,
`provider.ts`, `findings.ts`, `mutate.ts`). The five read tools and the kernel engine are
**read-only** and Obsidian-import-free (headlessly testable); [the three write tools](#the-three-write-tools)
are the module's mutating half and register differently — see below.

## `jd:` as a path address

Beside `uid:`, a path argument also accepts `<scheme>:<address>` — for the default
configuration, **`jd:06.11`**. It resolves at the same interception point as uid addressing,
**immediately after it** (`uid:` is reserved and always gets first look), so a call can freely
mix the two:

```jsonc
{"path": "jd:06.11", "content": "…"}                    // obsidian_write_note
{"from": "jd:06.11", "to": "jd:06.12"}                   // any path argument
```

Resolution runs over **allowlist-visible notes only** (`registry.ts`, wired at `guarded.ts`), so
it sees exactly the candidates `obsidian_resolve_address` would report:

- `Error [address_unresolved]` — no note *you can reach* carries the address (even if a hidden
  note does).
- `Error [address_ambiguous]` — two or more visible notes claim it; the error names only the
  candidates you could have named yourself (capped at 10).

`jd` is the **id** of the default Johnny-Decimal instance, not a hardwired prefix:
`DEFAULT_SCHEMES = [{ id: "jd", provider: "johnny-decimal" }]`, configurable via the top-level
`schemes` setting. The ref grammar is `<scheme-id>:<address>`; `uid:` is explicitly never
treated as a scheme ref.

## The five read tools

All read-only (`readOnlyHint: true`), registered through the module registry (which enforces
the read-only mount gate).

| Tool | Input | Returns |
| --- | --- | --- |
| **`obsidian_schemes`** | *(none)* | `{ schemes: [{ id, provider, capabilities, config, examples }] }` — every configured instance, its capabilities, the config override in effect, and a couple of example addresses in its own grammar (e.g. `jd:06.11`). |
| **`obsidian_resolve_address`** | `address?` **xor** `path?` | address → `{ address, found, path, duplicates?, ambiguous? }` or `{ found:false, parsed:{kind,levels} }`; path → `{ path, address, scheme }`. Reports duplicates; never picks or repairs. |
| **`obsidian_next_address`** | `scope` (e.g. `"06"`), `scheme?` | `{ scope, next, exhausted, allocatable, hint? }` — the next free address in that scope. **Compute-only.** |
| **`obsidian_list_scope`** | `scope`, `scheme?` | `{ scope, members:[{address,path}], free:{ next, gaps, truncated, allocatable, hint? } }` — members in address order plus up to 20 open slots (`free.truncated:true` when more exist). |
| **`obsidian_expected_location`** | `path?` **xor** `address?`, `scheme?` | `{ address, expected_folder, actual_folder, placed }` — where the scheme says it belongs, and whether it's there. |

### Error codes

- **`invalid_scope`** (coded) — a scope token that doesn't parse, from `obsidian_next_address`
  and `obsidian_list_scope`.
- **`address_unresolved`** / **`address_ambiguous`** — thrown by the addressing layer
  (`registry.ts`) during universal `jd:` path-argument rewriting, rendered as typed tool errors.
- Argument-shape refusals (both/neither of `address`/`path`, no scheme configured, multiple
  instances with no `scheme` specified, unknown scheme id) are **uncoded** `Error: …` messages.

Allowlist filtering in the scope tools is **silent** — a hidden note simply reads as not-found,
so there is no existence oracle for territory a session is sandboxed out of.

## The three write tools

The write half of the module (`mcp/tools-scheme-write.ts`) — completing chapter 6's
`ScopeProvider` with the mutation the read tools above only compute. Each is a thin
PLAN-then-APPLY shell over a pure planning core (`kernel/scheme/mutate.ts`'s
`planAssign`/`planRefile`/`planRenumber`): nothing in the tool layer recomputes "what should move
where", it only decides whether to preview (`dry_run: true`, **mandatory — no default** — on all
three) or execute via `moveOne` (`tools-vault-write.ts`'s move primitive, reused rather than
re-implemented, so these inherit the same link healing as `obsidian_move_notes`: `moveWithLinks`, a file-level rename plus vault-mcp's own backlink rewrite and damage check). The three are registered only while the scheme module is on: the module toggle (`modules.scheme.enabled`) turns them off with the read tools, on the next connect (#502).

| Tool | Input | Behavior |
| --- | --- | --- |
| **`obsidian_assign_address`** | `path`, `scope`, `scheme?`, `dry_run` | Moves the note into `scope`, assigning it the next free address the scope's own grammar computes — the same answer `obsidian_next_address` would give for that scope right now. Never overwrites: planning always targets a **free** address, so a race where something now occupies the computed path fails the move rather than clobbering it. |
| **`obsidian_refile_address`** | `path`, `dry_run` | Moves the note to the folder its **own** address says it belongs in — the fix for what `obsidian_expected_location` reports as `placed: false`. No `scope`/`scheme` argument: the note's address decides both. Already correctly filed reports `already_correct: true` with no move, regardless of `dry_run`. |
| **`obsidian_renumber_address`** | `path`, `to_address`, `scheme?`, `dry_run`, `on_occupied`, `displace_to_address?` | Moves the note to a specific target address `to_address` (parsed through the resolved instance's own grammar, not a bare guess — named `to_address`/`displace_to_address`, not `to`/`displace_to`, to avoid the argument-name collision those names had with the allowlist's own path-argument convention). If `to_address` is occupied, `on_occupied` decides: `"fail"` (default) refuses, `"auto"` displaces the occupant to the next free address in **its own** scope, `"manual"` displaces it to `displace_to_address` (required and parsed only in that branch). A displaced occupant's move runs before the source note's own move, in the plan and at apply time. |

`dry_run: false` execution on `obsidian_renumber_address` runs its steps sequentially — never in
parallel — so a mid-sequence failure after at least one step has already landed returns an error
naming exactly which moves completed and which one failed, rather than hiding a partially-applied
vault behind a bare rethrow.

**Allowlist discipline matches the read tools**: `ctx.notes()` is filtered through `visiblePaths`
before it reaches any provider method or planning function, and the note being operated on
(`path`) gets the same one-path `out_of_allowlist` check the reverse-lookup tools use, refused
before planning runs — a hidden note can be neither read as "what's there" nor written to by
these tools.

**Registration is direct, not through the module registry.** The [module registry](module-system.md)'s
`registerAll` gate refuses any tool whose `annotations.readOnlyHint !== true` — a capability
module is load-bearing read-only-or-nothing by that gate's design. These three tools mutate by
design, so they register directly in `server.ts`, the same way `obsidian_move_notes`/
`obsidian_repoint_link` already do — not a workaround, the shape the existing hand-registered
write tools use — sharing the identical `registry()`/`notes()` pair the read tools' registrar
takes, so both halves see the same live-reloaded settings.

## Allocation computes, it does not reserve

`obsidian_next_address` and `obsidian_list_scope`'s free-slot answers are **computed, never
reserved**. Straight from the module's own header:

> Nothing here mutates anything. `obsidian_next_address` in particular only **computes** — the
> actual exclusivity story is `obsidian_claim_scope` … two sessions racing this tool can compute
> the identical answer, and only a claim (or the note actually landing) settles who gets it.

So the tool's answer holds only until a note actually lands there. For exclusivity while you
create the note, pair it with an [advisory scope claim](kernel-v0.md#advisory-scope-locks--ttl).
Under an allowlist, a hidden note can hold a slot these tools report as free — "next free" is
only ever free among what your session can see.

## Johnny Decimal grammar (the default provider)

`jd.ts` recognizes: `area` (`00-09`), `category` (`06`), `id` (`06.11` / `06.110`),
`expanded-item` (`92021` / `27001`), and `fractal-id` (`92021.10`). Its capabilities are
`{ validate, itemAddresses, allocate, ordered }`. Content decimals start at a configurable floor
(default `.10` — `.00–.09` reserved as standard zeros). Default config expands the `90-99` area
and the `27` category. `allocatable(scope)` returns `{ allocatable:false, hint }` for scopes that
can't take a fresh content id (plain areas, expanded-items, categories folded into an expanded
band) — distinct from a fully allocatable scope.

## Conformance findings (not a tool)

`packages/core/src/scheme/findings.ts` is a scheme-conformance rule-pack (finding codes
`misfiled`, `duplicate_address`, `malformed_name`, `unaddressed`) that is deliberately **not
registered as a tool** — capabilities arrive as rule packs, not as new mutating surface. It is
available to future review/rail surfaces, not to agents as a write path.
