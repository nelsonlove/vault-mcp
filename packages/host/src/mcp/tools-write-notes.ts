// obsidian_write_notes — batch write + opt-in server-side stamping (slice B1).
//
// The MIRROR of obsidian_move_notes, but with one deliberate difference that is
// the whole point of the slice: every item gets its OWN journal record, so
// Stewardship sees each note individually. A batch move is one operation over
// many paths (one record, `target.paths`); a batch write is N independent
// writes that happen to be submitted together.
//
// ── why it dispatches instead of writing inline ──────────────────────────────
//
// To give each item its own record, each item must run through the kernel's
// runMutation — the SAME serialized queue + journal + if_rev + idempotency that
// backs every single write. But the guard monkeypatch (server.ts) already wraps
// every MUTATING registration in ONE runMutation, and the write queue is
// non-reentrant (a queued closure that enqueues again deadlocks behind itself).
//
// So this tool follows the obsidian_call_tool precedent exactly: it registers
// UNGUARDED (via the pre-monkeypatch registrar) so it takes no outer queue slot,
// and drives a per-item GUARDED single-writer itself. The per-item handler is a
// real makeGuarded wrapper, so uid addressing, read-only mode, the allowlist,
// if_rev, idempotency and the journal all bind per item exactly as on the full
// surface — nothing is reimplemented. A read-only session's items each fail with
// `read_only`; an out-of-allowlist path fails with `out_of_allowlist`; the batch
// never aborts on one item's failure.
//
// Obsidian-free by construction: the two Obsidian-touching concerns — reading a
// note's existing frontmatter from the metadata cache and serializing YAML — are
// injected by server.ts, so the dispatch/compose/stamp/accept-forbidden surface
// is unit-testable headlessly against a real Kernel and fake vault.

import { z } from "zod";
import { ok, okError, codedError } from "./helpers.js";
import { PROTECTION_REQUIRED } from "../kernel/write-protection.js";
import { composeNote, AcceptForbiddenError, type ComposeResult } from "./write-notes-compose.js";

/** readOnlyHint:false is honest — this tool mutates. It bypasses the monkeypatch, not the truth. */
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/**
 * The per-item writer behind `GuardedWrite` — the handler the guarded wrapper
 * runs at DEQUEUE, after the kernel's idempotency and if_rev checks. One item
 * is one write_note (01.33: "write notes (batch): per item, as write note"):
 * an item carrying no if_rev arrives with `create_only` and is a create
 * (exempt), so a note that already exists is refused here with the coded
 * message naming if_rev — never overwritten without a token. Refusing HERE,
 * not before the queue, is what keeps a retry working: a replay under the
 * same idempotency_key is answered by the kernel before this runs. The cost:
 * this refusal is a returned envelope, so the kernel stores it under the
 * item's key, and the overwrite that follows needs a new key (the message
 * says so).
 */
export function batchItemWriter(
  write: (path: string, content: string, overwrite: boolean) => unknown | Promise<unknown>,
  exists: (path: string) => boolean
) {
  return async ({ path, content, overwrite, create_only }: { path: string; content: string; overwrite?: boolean; create_only?: boolean }) => {
    if (create_only && exists(path)) {
      return codedError(
        PROTECTION_REQUIRED,
        `'${path}' already exists, and this batch item carries no if_rev, so it is a create (01.33 rule 6f: an overwrite needs a token). ` +
          "Nothing was written. To overwrite it, read the note (obsidian_read_note returns `rev`) and pass that value as the item's if_rev. " +
          "If this item carried an idempotency_key, give the overwrite a NEW one: that key now answers with this refusal."
      );
    }
    return ok(await write(path, content, create_only ? false : (overwrite ?? true)));
  };
}

/** The guarded single-writer this tool drives, one call per item. Returns an MCP result envelope. */
export type GuardedWrite = (
  args: { path: string; content: string; overwrite: boolean; create_only?: boolean; if_rev?: number; idempotency_key?: string; intent?: string },
  extra: unknown
) => Promise<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> }>;

export interface WriteNotesDeps {
  /**
   * Resolve `uid:<value>` / `<scheme>:<address>` addressing for one item's
   * `path` AND check read-only + allowlist for it — the SAME resolution and
   * refusal `guardedWrite`'s own dispatch applies (guarded.ts's
   * `resolveGuardedPath`), run here FIRST, before compose. Two reasons it has
   * to happen here rather than only inside `guardedWrite`:
   *
   *   1. `readExistingFrontmatter` below is keyed on a real vault path — the
   *      metadata cache has no entry under a `uid:`/`jd:` reference — so stamp
   *      preservation (existing uid/created/acceptance-status) needs the
   *      RESOLVED path, not the caller's raw argument.
   *   2. The allowlist/read-only refusal must be the FIRST thing a hidden or
   *      blocked item produces — before compose's accept-transition check ever
   *      inspects the note's frontmatter — or the error a caller sees would
   *      differ by whether the payload happens to carry an acceptance-family
   *      field, leaking information about a note this session cannot see.
   */
  resolveTarget: (path: string) => { path: string } | { blocked: { code: string; message: string } };
  /** Existing on-disk frontmatter for a path (metadata cache), or undefined. For stamp preservation. */
  readExistingFrontmatter: (path: string) => Record<string, unknown> | undefined;
  /** The revision (mtime ms) of a path after a write, for the per-item report. */
  revOf?: (path: string) => number | undefined;
  /** Serialize frontmatter to YAML — obsidian.stringifyYaml in production. */
  stringifyYaml: (obj: Record<string, unknown>) => string;
  /** Parse a YAML frontmatter block — obsidian.parseYaml in production. For the accept-forbidden body-injection check. */
  parseYaml?: (yaml: string) => unknown;
  /** Mint a created-seeded uid — uuidv7 in production. */
  mintUid: (createdMs: number) => string;
  /** Format an ms timestamp for frontmatter — formatLocalTimestamp in production. */
  formatTs: (ms: number) => string;
  /** Wall-clock now, ms. Injected for deterministic tests. */
  now?: () => number;
}

type PerItemResult =
  | { ok: true; path: string; created: boolean; stamped: boolean; rev?: number; sync_warning?: string }
  | { ok: false; path: string; code: string; error: string };

/** Pull `Error [code]: message` out of a guarded-write error envelope. */
function decodeError(envelope: { content?: Array<{ text?: string }> }): { code: string; error: string } {
  const text = envelope.content?.[0]?.text ?? "error";
  const m = /^Error \[([^\]]+)\]:\s*([\s\S]*)$/.exec(text);
  if (m) return { code: m[1], error: m[2] };
  const bare = /^Error:\s*([\s\S]*)$/.exec(text);
  return { code: "error", error: bare ? bare[1] : text };
}

/**
 * Register obsidian_write_notes.
 *
 * @param register  the PRE-monkeypatch registrar (origRegister in server.ts) — so this
 *                  tool is not itself wrapped in runMutation (no outer queue slot).
 * @param guardedWrite  a makeGuarded-wrapped single-writer (server.ts builds it from
 *                  the real Kernel + backend); each item is dispatched through it.
 */
export function registerWriteNotesTool(
  register: (name: string, def: unknown, handler: unknown) => unknown,
  guardedWrite: GuardedWrite,
  deps: WriteNotesDeps
): void {
  const now = deps.now ?? (() => Date.now());

  register(
    "obsidian_write_notes",
    {
      title: "Write multiple notes (with optional server-side stamping)",
      description:
        "Write several notes in one call, each as {path, frontmatter?, body}. Every item is an INDEPENDENT write routed " +
        "through the same serialized write queue, write journal and if_rev/idempotency machinery as a single write — so " +
        "each note gets its OWN journal record and Stewardship sees it individually. Items are processed sequentially; a " +
        "failed item (out-of-allowlist, if_rev conflict, accept-forbidden) is reported in `errors` and does NOT abort the " +
        "batch. Each item may carry its own `if_rev` (optimistic concurrency) and `idempotency_key` (retry-safety). " +
        "Existing notes are REPLACED (this writes whole notes, like obsidian_write_note). " +
        "A NEW note's path may not hold a character Obsidian Sync refuses (\\ : * ? \" < > |) or one that breaks links (# ^ [ ]): that item is refused with `unsafe_name`. [ ] are allowed only in the name of a note under an existing archive folder (one the plugin's archive pattern names) that no other note links to, never in a folder name. " +
        "Set `stamp: true` to make the server the single owner of frontmatter conventions: it mints a created-seeded " +
        "UUIDv7 `uid` only when absent (an existing uid is never overwritten), sets `created` (if missing) and `modified` " +
        "(always), enforces canonical field order, and adds no `acceptance-status` (an existing one on disk is kept). Stamping " +
        "NEVER writes acceptance, and any item whose frontmatter sets accepted/accepted-by/accepted-on is REJECTED " +
        "(Error [accept_forbidden]) — acceptance is a human gesture, in no API. `stamp` is opt-in per call; leave it off " +
        "for templates/blueprints, where a uid on a merge-payload would corrupt every instance.",
      inputSchema: {
        notes: z
          .array(
            z.object({
              path: z.string().min(1).describe("Vault-relative path ending in .md (or uid:<value>)."),
              frontmatter: z
                .record(z.unknown())
                .optional()
                .describe("Frontmatter key/values. Under stamp:true the server fills uid/created/modified and canonical order."),
              body: z.string().default("").describe("Markdown body below the frontmatter."),
              if_rev: z
                .number()
                .optional()
                .describe("REQUIRED to overwrite a note that exists (01.33 rule 6f): the note's rev from a read. An item without it is a CREATE, and is refused with Error [protection_required] if the note already exists. With it, the write lands only if the note is still at this rev; else Error [rev_conflict], nothing written."),
              idempotency_key: z
                .string()
                .min(1)
                .max(200)
                .optional()
                .describe("Per-item retry-safety key: a repeat with the same key replays the first result instead of writing again."),
            })
          )
          .min(1)
          .max(50)
          .describe("The notes to write, e.g. [{path:'Inbox/A.md', frontmatter:{name:'A'}, body:'…'}]."),
        stamp: z
          .boolean()
          .default(false)
          .describe("Opt-in server-side stamping: uid (v7, created-seeded, only if absent) + created/modified + canonical order. Adds no acceptance-status; never writes acceptance."),
        intent: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            "Why this change-set is being made — advisory agent-authored text recorded on EVERY item's journal " +
              "record (review surfaces display it per pending row as \"agent says\"). Journal-only: never written " +
              "to the notes, never trusted, never an acceptance signal."
          ),
      },
      annotations: RW,
    },
    async (
      { notes, stamp, intent }: { notes: Array<{ path: string; frontmatter?: Record<string, unknown>; body?: string; if_rev?: number; idempotency_key?: string }>; stamp?: boolean; intent?: string },
      extra: unknown
    ) => {
      const doStamp = stamp === true;
      const results: PerItemResult[] = [];

      for (const item of notes) {
        // Resolve uid:/jd: addressing AND check read-only/allowlist FIRST —
        // the SAME resolution + refusal guardedWrite's own dispatch applies
        // below, run here BEFORE compose (see WriteNotesDeps.resolveTarget).
        // A blocked item never reaches compose: the allowlist refusal is the
        // only thing it produces, regardless of what its frontmatter carries
        // (Finding 5), and it takes no queue slot / journal record, exactly
        // like the accept-forbidden rejection below (Finding 3's fix keeps
        // that property — nothing here dispatches early).
        const resolved = deps.resolveTarget(item.path);
        if ("blocked" in resolved) {
          results.push({ ok: false, path: item.path, code: resolved.blocked.code, error: resolved.blocked.message });
          continue;
        }
        const resolvedPath = resolved.path;

        // Compose + accept-forbidden guard run OUTSIDE the queue: a rejected item
        // never dispatches, so it takes no slot and writes no journal record.
        // `existing` is keyed on the RESOLVED path — the metadata cache has no
        // entry under a `uid:`/`jd:` reference, so a stamped write addressed
        // that way now preserves uid/created/acceptance-status exactly like the
        // same write addressed by its plain path (Finding 3).
        let composed: ComposeResult;
        try {
          composed = composeNote({
            frontmatter: item.frontmatter,
            body: item.body ?? "",
            stamp: doStamp,
            existing: deps.readExistingFrontmatter(resolvedPath),
            now: now(),
            mintUid: deps.mintUid,
            formatTs: deps.formatTs,
            stringifyYaml: deps.stringifyYaml,
            parseYaml: deps.parseYaml,
          });
        } catch (e) {
          if (e instanceof AcceptForbiddenError) {
            results.push({ ok: false, path: item.path, code: e.code, error: e.message });
            continue;
          }
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ ok: false, path: item.path, code: "compose_failed", error: msg });
          continue;
        }

        // Dispatch through the guarded single-writer: uid addressing, read-only,
        // allowlist, if_rev, idempotency, queue and journal all bind here, per
        // item. The path handed over is already RESOLVED (a no-op re-resolution
        // inside guardedWrite, since it is no longer `uid:`/`jd:`-shaped) — the
        // second allowlist check is defense-in-depth, not a second decision.
        try {
          // Each item is a single write_note under the 01.33 table ("write
          // notes (batch): per item, as write note"). An item WITH if_rev is an
          // overwrite, and the kernel checks the token at dequeue. An item
          // WITHOUT one is a create-if-absent (exempt): `create_only` tells
          // the per-item writer to refuse, at dequeue, a note that already
          // exists — naming if_rev as the way to overwrite it. The decision
          // is made from the ARGUMENTS, not from the vault, so a retry with
          // the same idempotency_key carries the same arguments and replays
          // the first result instead of being refused (01.43 rules 3, 4, 4a).
          const envelope = await guardedWrite(
            {
              path: resolvedPath,
              content: composed.content,
              overwrite: true,
              create_only: item.if_rev === undefined,
              ...(item.if_rev !== undefined ? { if_rev: item.if_rev } : {}),
              ...(item.idempotency_key !== undefined ? { idempotency_key: item.idempotency_key } : {}),
              // The batch-level intent describes the change-SET; the guarded
              // single-writer peels it per item, so every item's journal record
              // carries it and Stewardship's per-note rows each show it.
              ...(intent !== undefined ? { intent } : {}),
            },
            extra
          );
          if (envelope?.isError) {
            const { code, error } = decodeError(envelope);
            results.push({ ok: false, path: item.path, code, error });
          } else {
            const created = envelope?.structuredContent?.created === true;
            // The Sync guard's warning (#507) is on the item's envelope; carry it
            // to the item's row, or the batch's caller would never see it.
            const syncWarning = envelope?.structuredContent?.sync_warning;
            results.push({
              ok: true,
              path: item.path,
              created,
              stamped: composed.stamped,
              ...(deps.revOf ? { rev: deps.revOf(resolvedPath) } : {}),
              ...(typeof syncWarning === "string" ? { sync_warning: syncWarning } : {}),
            });
          }
        } catch (e) {
          // A guarded-write should return an envelope, not throw; if it does,
          // one item's crash must not sink the batch.
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ ok: false, path: item.path, code: "error", error: msg });
        }
      }

      const written = results.filter((r): r is Extract<PerItemResult, { ok: true }> => r.ok);
      const errors = results.filter((r): r is Extract<PerItemResult, { ok: false }> => !r.ok);
      const payload = {
        count: written.length,
        error_count: errors.length,
        stamped: doStamp,
        written: written.map(({ path, created, stamped, rev, sync_warning }) => ({ path, created, stamped, ...(rev !== undefined ? { rev } : {}), ...(sync_warning !== undefined ? { sync_warning } : {}) })),
        errors: errors.map(({ path, code, error }) => ({ path, code, error })),
      };
      // Partial failure is tolerated; total failure carries the MCP error flag
      // (okError keeps the structured per-item report, which fail() would flatten).
      return written.length === 0 && errors.length > 0 ? okError(payload) : ok(payload);
    }
  );
}
