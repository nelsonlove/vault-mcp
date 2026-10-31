// The scope-provider module's WRITE surface: three mutating tools over the
// ScopeRegistry (kernel/scheme/registry.ts) and the pure planning core
// (kernel/scheme/mutate.ts) — assign a note the next free address in a scope,
// refile a note back to where its own address says it belongs, and renumber a
// note to a specific target address (optionally displacing whatever already
// occupies it).
//
// Each tool is a thin PLAN-then-APPLY shell: the planning half
// (planAssign/planRefile/planRenumber) is pure and lives in mutate.ts —
// nothing here recomputes "what should move where", it only decides whether
// to preview the plan (`dry_run: true`) or execute it via `moveOne`
// (tools-vault-write.ts's move primitive, reused rather than re-implemented).
//
// Cannot register through modules-mount.ts: that host's `registerAll` gate
// refuses any tool whose `annotations.readOnlyHint !== true` (its own header
// comment, point 1, pinned by its own test suite). These three tools mutate
// by design, so they register directly in server.ts, exactly the way
// `registerVaultWriteTools`'s `obsidian_move_notes`/`obsidian_repoint_link`
// already do — not a workaround, the same shape the existing write tools use.
//
// Allowlist-aware like tools-scheme.ts's read tools: `ctx.notes()` is
// filtered through `visiblePaths` before it ever reaches a provider method or
// a planning function, and the note being OPERATED ON (`path`) gets the same
// one-path check tools-uid.ts's reverse lookup uses — rejected with a coded
// `out_of_allowlist` refusal before any planning runs, so a hidden note can be
// neither read as "what's there" nor written to by these tools.
//
// `excludedRoots` discipline matches the read tools too: an instance's
// `excludeRoots(...)` is applied to every notes listing these tools plan
// against, and a `path` argument this instance's excludedRoots covers is
// treated the same way tools-scheme.ts treats it — the instance does not
// speak for that note, so it refuses rather than silently operating on
// territory outside what the instance claims.
//
// The destination a plan computes (`MoveStep.to`, and for renumber the
// displaced occupant's own path) is NOT itself an argument, so the guard's
// argument-level allowlist check never sees it — `expectedFolder` derives a
// folder PREFIX from the (already-filtered) notes listing, which can in
// principle be shorter than an allowlist prefix. So every computed path is
// re-checked with `isVisible` before anything is applied — unconditionally,
// even under `dry_run: true`, so a preview never claims a plan this session
// could not actually carry out.

import { assertMoveName } from "./name-checks.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { ok, fail, codedError } from "./helpers.js";
import { visiblePaths, isVisible, type GuardSettings } from "../guard.js";
import { pickInstance, parseScopeToken } from "./tools-scheme.js";
import { moveOne, RW } from "./tools-vault-write.js";
import { TextCache } from "./move-with-links.js";
import { recordTest, type RecordRules } from "./records.js";
import { planAssign, planRefile, planRenumber, type MoveStep, type OnOccupied } from "../kernel/scheme/mutate.js";
import type { Address } from "../kernel/scheme/provider.js";
import { excludeRoots, type SchemeInstance, type SchemeRegistry, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";

export interface SchemeWriteToolsCtx {
  /** Rebuilt from settings per call — config edits land live, no reconnect needed. */
  registry: () => SchemeRegistry;
  /** Vault markdown paths; wired in server.ts from app.vault.getMarkdownFiles(). */
  notes: () => string[];
  getSettings?: () => GuardSettings & { schemes?: SchemeInstanceConfig[] };
  /** The operator's record identification (#397), for the moves' record test (records.ts). Absent ⇒ the default `record: true`. */
  recordIdentification?: () => RecordRules;
}

// Intentionally-duplicated one-liner: `@vault-mcp/core`'s `fail()` does this
// same `err instanceof Error ? err.message : String(err)` extraction
// internally, but doesn't export it standalone — it's folded straight into
// building fail()'s own response shape. This helper needs just the bare
// message text to INTERPOLATE into the "vault is in an inconsistent state"
// error below, not a whole response object, so reusing fail() here isn't a
// fit; exporting a new standalone helper from core for one call site in one
// other package isn't worth the cross-package churn. Kept as its own
// (trivially small) copy rather than left unexplained.
function moveErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerSchemeWriteTools(server: McpServer, app: App, ctx: SchemeWriteToolsCtx): void {
  const visible = (paths: string[]): string[] => visiblePaths(paths, ctx.getSettings?.());
  const outOfAllowlist = (path: string) =>
    codedError("out_of_allowlist", `path '${path}' is outside the vault-mcp allowlist`);
  // A computed destination (not a call argument) failing visibility — see the
  // header comment above. Distinguished from `outOfAllowlist` in wording only
  // (same code: a caller branching on `out_of_allowlist` should not have to
  // know whether the offending path was named or computed).
  const computedOutOfAllowlist = (path: string) =>
    codedError("out_of_allowlist", `the computed destination '${path}' is outside the allowlist`);
  // `path` is excluded from `instance`'s territory by its own `excludedRoots`
  // — the write-tool counterpart to tools-scheme.ts's `reason: "excluded"`
  // read-side reporting: a read can afford to just say so, but a write must
  // refuse outright rather than operate on territory the instance disclaims.
  const excludedFromInstance = (path: string, instance: SchemeInstance) =>
    codedError("excluded_root", `note '${path}' is excluded from scheme instance "${instance.id}"'s territory (excludedRoots)`);
  /** First path in `paths` that fails `isVisible`, or null if all pass. */
  const firstHidden = (paths: string[]): string | null => {
    for (const p of paths) {
      if (!isVisible(p, ctx.getSettings?.())) return p;
    }
    return null;
  };
  // Static, argument-only check — matches obsidian_move_notes's precedent
  // (validateMoves in helpers.ts rejects a non-.md batch item BEFORE any move
  // logic runs). Without this, `titleOf` only strips a trailing `.md$` and
  // does nothing for any other extension, so a call on e.g. "Foo.txt" would
  // silently compute a nonsensical double-extension destination
  // ("… Foo.txt.md") instead of refusing outright — and on `dry_run: false`
  // the problem would only surface later, deep inside `moveOne`, as an
  // inconsistent "source must end in .md" throw. Run this FIRST, right after
  // argument parsing, before any allowlist/instance/planning logic.
  const notMd = (path: string) => (path.endsWith(".md") ? null : fail(new Error("path must end in .md")));

  // ── obsidian_assign_address ─────────────────────────────────────────────
  server.registerTool(
    "obsidian_assign_address",
    {
      title: "Assign a note the next free address in a scope",
      description:
        "Move a note into a scope (e.g. category \"06\"), assigning it the next free address the scope's own " +
        "grammar computes (same answer `obsidian_next_address` would give for the same scope right now). " +
        "`dry_run: true` reports the address and the move that would happen without touching the vault; " +
        "`dry_run: false` performs it. Never overwrites — planning always targets a FREE address, so a race where " +
        "something now occupies the computed path fails the move rather than clobbering it. Mutating.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to assign an address to."),
        scope: z.string().min(1).describe('A scope token in the scheme\'s own grammar, e.g. "06", "50-59", "34".'),
        scheme: z
          .string()
          .min(1)
          .optional()
          .describe("Which configured scheme instance to use. Defaults to the single configured instance; required when several are configured."),
        dry_run: z.boolean().describe("If true, report the computed address and move without performing it."),
      },
      annotations: RW,
    },
    async ({ path, scope, scheme, dry_run }) => {
      try {
        const mdError = notMd(path);
        if (mdError) return mdError;

        const registry = ctx.registry();
        const pick = pickInstance(registry, scheme);
        if ("unavailable" in pick) return codedError("scheme_unavailable", pick.unavailable);
        if ("error" in pick) return fail(new Error(pick.error));
        const { instance } = pick;

        const parsedScope = parseScopeToken(instance, scope);
        if (!parsedScope) return codedError("invalid_scope", `"${scope}" does not parse as a scope in scheme "${instance.id}"`);

        if (visible([path]).length === 0) return outOfAllowlist(path);
        if (excludeRoots([path], instance.excludedRoots).length === 0) return excludedFromInstance(path, instance);

        const visibleNotes = excludeRoots(visible(ctx.notes()), instance.excludedRoots);
        const outcome = planAssign(instance.provider, parsedScope, path, visibleNotes);
        if (!outcome.ok) return fail(new Error(outcome.error));
        const { result } = outcome;

        const hidden = firstHidden([result.step.to]);
        if (hidden) return computedOutOfAllowlist(hidden);

        // The name is checked before a dry run answers, so a preview never promises a move the real run refuses.
        await assertMoveName(app, result.step.from, result.step.to);
        if (dry_run) return ok({ dry_run: true, address: result.address, moves: [result.step] });

        try {
          await moveOne(app, result.step.from, result.step.to, false, { isRecord: recordTest(ctx.recordIdentification) });
        } catch (e) {
          return fail(e);
        }
        return ok({
          dry_run: false,
          address: result.address,
          moves: [result.step],
          filesChanged: 1,
          files: [result.step.to],
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── obsidian_refile_address ─────────────────────────────────────────────
  server.registerTool(
    "obsidian_refile_address",
    {
      title: "Refile a note back to where its own address says it belongs",
      description:
        "Move a note to the folder its OWN address (the leading token in its filename) says it should live in — " +
        "the fix for a misfiled note `obsidian_expected_location` reports as `placed: false`. No `scope`/`scheme` " +
        "argument: the note's address decides which configured scheme instance and which scope apply. Already " +
        "correctly filed reports `already_correct: true` with no move, regardless of `dry_run`. `dry_run: true` " +
        "reports the move that would happen without performing it. Mutating.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to refile."),
        dry_run: z.boolean().describe("If true, report the computed move without performing it."),
      },
      annotations: RW,
    },
    async ({ path, dry_run }) => {
      try {
        const mdError = notMd(path);
        if (mdError) return mdError;

        if (visible([path]).length === 0) return outOfAllowlist(path);

        const registry = ctx.registry();
        // Same fall-through discipline as tools-scheme.ts's obsidian_resolve_address
        // / obsidian_expected_location: an instance that recognizes this note's
        // address but excludes its territory does not get to claim it — keep
        // looking for a non-excluding instance instead, and remember that at
        // least one instance turned it away so the eventual refusal (if no
        // instance claims it) can say why.
        //
        // Unlike that fall-through, this tool does NOT stop at the first
        // non-excluding match: it collects EVERY non-excluding instance that
        // recognizes the address, because this tool (unlike
        // obsidian_resolve_address/obsidian_expected_location) takes no
        // `scheme` argument to disambiguate a genuine multi-instance overlap
        // — silently picking whichever instance iterated first would compute
        // the move against the wrong instance's config with no way for the
        // caller to say otherwise. Matches the discipline
        // resolveBareOrRef/resolveAddressAndInstance (tools-scheme.ts) already
        // apply to the `address` argument direction.
        let excludedByAny = false;
        const matches: SchemeInstance[] = [];
        for (const inst of registry.instances()) {
          if (!inst.provider.addressOf(path)) continue;
          if (excludeRoots([path], inst.excludedRoots).length === 0) {
            excludedByAny = true;
            continue;
          }
          matches.push(inst);
        }
        if (matches.length > 1) {
          return codedError(
            "scheme_ambiguous",
            `note's address is recognized by ${matches.length} scheme instances (${matches
              .map((i) => i.id)
              .join(", ")}) — obsidian_refile_address takes no \`scheme\` argument to disambiguate; use ` +
              "obsidian_renumber_address with an explicit `scheme` instead"
          );
        }
        const instance = matches[0] ?? null;
        if (!instance) {
          return fail(
            new Error(
              excludedByAny
                ? "note's address is recognized only by scheme instance(s) whose excludedRoots exclude it"
                : "note has no address in any configured scheme"
            )
          );
        }

        const visibleNotes = excludeRoots(visible(ctx.notes()), instance.excludedRoots);
        const outcome = planRefile(instance.provider, path, visibleNotes);
        if (!outcome.ok) return fail(new Error(outcome.error));
        const { result } = outcome;

        if (result.alreadyCorrect) {
          return ok({ dry_run, address: result.address, moves: [], already_correct: true });
        }
        const step = result.step;
        if (!step) return fail(new Error("planRefile reported a move with no step"));

        const hidden = firstHidden([step.to]);
        if (hidden) return computedOutOfAllowlist(hidden);

        await assertMoveName(app, step.from, step.to);
        if (dry_run) return ok({ dry_run: true, address: result.address, moves: [step] });

        try {
          await moveOne(app, step.from, step.to, false, { isRecord: recordTest(ctx.recordIdentification) });
        } catch (e) {
          return fail(e);
        }
        return ok({
          dry_run: false,
          address: result.address,
          moves: [step],
          filesChanged: 1,
          files: [step.to],
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── obsidian_renumber_address ───────────────────────────────────────────
  server.registerTool(
    "obsidian_renumber_address",
    {
      title: "Renumber a note to a specific target address",
      description:
        "Move a note to a specific target address `to_address`, in the resolved scheme instance's own grammar (not " +
        "a bare guess — `to_address`/`displace_to_address` are parsed through that instance's `provider.parse`). If " +
        "`to_address` is already occupied, `on_occupied` decides what happens: \"fail\" (default) refuses; \"auto\" " +
        "displaces the occupant to the next free address in ITS OWN scope; \"manual\" displaces the occupant to " +
        "`displace_to_address`, which must be given and free. Whenever an occupant is displaced, its move always " +
        "runs BEFORE the source note's own move, both in the reported plan and in execution order. `dry_run: true` " +
        "reports the moves without performing them; `dry_run: false` executes them sequentially — never in " +
        "parallel, so a failure partway through cannot race the remaining steps. Mutating.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to renumber."),
        to_address: z.string().min(1).describe('The target address in the scheme\'s own grammar, e.g. "06.20". (Not a vault path.)'),
        scheme: z
          .string()
          .min(1)
          .optional()
          .describe("Which configured scheme instance to use. Defaults to the single configured instance; required when several are configured."),
        dry_run: z.boolean().describe("If true, report the computed move(s) without performing them."),
        on_occupied: z
          .enum(["auto", "manual", "fail"])
          .default("fail")
          .describe('What to do if `to_address` is already occupied: "fail" (default, refuse), "auto" (displace the occupant to its own scope\'s next free slot), or "manual" (displace the occupant to `displace_to_address`).'),
        displace_to_address: z
          .string()
          .min(1)
          .optional()
          .describe('Where to displace the current occupant of `to_address`, in the scheme\'s own grammar (not a vault path). Required (and used) only when `on_occupied` is "manual".'),
      },
      annotations: RW,
    },
    async ({ path, to_address, scheme, dry_run, on_occupied, displace_to_address }) => {
      try {
        const mdError = notMd(path);
        if (mdError) return mdError;

        const registry = ctx.registry();
        const pick = pickInstance(registry, scheme);
        if ("unavailable" in pick) return codedError("scheme_unavailable", pick.unavailable);
        if ("error" in pick) return fail(new Error(pick.error));
        const { instance } = pick;

        const parsedTo = instance.provider.parse(to_address);
        if (!parsedTo) return fail(new Error(`"${to_address}" does not parse as an address in scheme "${instance.id}"`));

        let parsedDisplaceTo: Address | undefined;
        if (on_occupied === "manual" && displace_to_address !== undefined) {
          const parsed = instance.provider.parse(displace_to_address);
          if (!parsed) {
            return fail(new Error(`"${displace_to_address}" does not parse as an address in scheme "${instance.id}"`));
          }
          parsedDisplaceTo = parsed;
        }

        if (visible([path]).length === 0) return outOfAllowlist(path);
        if (excludeRoots([path], instance.excludedRoots).length === 0) return excludedFromInstance(path, instance);

        const address = instance.provider.format(parsedTo);
        const visibleNotes = excludeRoots(visible(ctx.notes()), instance.excludedRoots);
        const outcome = planRenumber(
          instance.provider,
          path,
          parsedTo,
          visibleNotes,
          on_occupied as OnOccupied,
          parsedDisplaceTo
        );
        if (!outcome.ok) return outcome.code ? codedError(outcome.code, outcome.error) : fail(new Error(outcome.error));
        const { result } = outcome;

        // Every computed path — each step's `to`, plus (for a displaced
        // occupant) its `from`, which is computed by occupantOf rather than
        // named by the caller — must itself be visible before anything is
        // planned to happen to it, dry_run or not (see the header comment).
        const computedPaths = result.steps.flatMap((s) => [s.from, s.to]);
        const hidden = firstHidden(computedPaths);
        if (hidden) return computedOutOfAllowlist(hidden);

        // One read of the vault's text for the whole renumber, the name checks included, as obsidian_move_notes does (see TextCache).
        const texts = new TextCache(app);
        // Every step's name is checked before ANY step runs (and before a dry run answers): a refusal on step 2 must
        // not come after step 1 has already moved the occupant away.
        for (const st of result.steps) await assertMoveName(app, st.from, st.to, false, texts);
        if (dry_run) return ok({ dry_run: true, address, moves: result.steps, displaced: result.displaced });

        const completed: MoveStep[] = [];
        // One record test for the whole renumber.
        const isRecord = recordTest(ctx.recordIdentification);
        for (const step of result.steps) {
          try {
            await moveOne(app, step.from, step.to, false, { texts, isRecord });
            completed.push(step);
          } catch (e) {
            if (completed.length === 0) return fail(e);
            const failedStep = step;
            const priorDescription = completed.map((s) => `'${s.from}' -> '${s.to}'`).join(", ");
            return fail(
              new Error(
                `vault is in an inconsistent state: already moved ${priorDescription}, but failed to move ` +
                  `'${failedStep.from}' to '${failedStep.to}': ${moveErrorMessage(e)}`
              )
            );
          }
        }
        return ok({
          dry_run: false,
          address,
          moves: result.steps,
          displaced: result.displaced,
          filesChanged: completed.length,
          files: completed.map((s) => s.to),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
