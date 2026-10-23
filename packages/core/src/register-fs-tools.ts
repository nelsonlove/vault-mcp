/**
 * registerFsTools — wire the 17 FS_TOOLS definitions onto an MCP server.
 *
 * Iterates FS_TOOLS and calls server.registerTool for each, supplying a
 * handler that dispatches to the provided VaultBackend. Response envelopes
 * match the server's pre-refactor shapes exactly so callers see no change.
 *
 * No dependency on @modelcontextprotocol/sdk here — the server parameter is
 * typed as a structural duck type that McpServer satisfies.
 */

import type { VaultBackend, FrontmatterEditValue } from "./vault-backend.js";
import { FS_TOOLS } from "./tool-registry.js";
import { ok, fail } from "./responses.js";
import { CHARACTER_LIMIT, decodeHtmlEntities } from "./fs-backend/vault.js";
import { isCutRead } from "./truncation.js";
import { strictInput } from "./strict-input.js";
import { z } from "zod";
import { profileAllows, profileCallRefusal, type ConnProfile } from "./profile.js";
import { SNIPPET_TOOLS, type SecretScanner } from "./secret-scan.js";
import { renderNoteWithFrontmatter, opensWithFrontmatter, jsonFlowYaml } from "./note-frontmatter.js";
import { registerSendMessageTool, type MessageConfig, type MessageSender } from "./send-message.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Snapshot returned by includeIndexStatus. Typed for use inside the
 * obsidian_force_reindex handler which needs to read status fields.
 */
export interface IndexStatusSnapshot {
  status: string;
  count: number;
  last_built_at?: string;
  error?: string;
}

export interface RegisterFsToolsOpts {
  /**
   * Name the kernel arguments (`if_rev`, `idempotency_key`, `intent`) on each strict write tool, accepted and
   * not checked. For the file-system server only, which has no kernel: without them its strict write tools
   * would refuse a key a client sends because the plugin requires it. The plugin leaves this off and adds
   * its own copies, with their REQUIRED lead, through `withKernelArgs` (#546 review 2).
   */
  kernelArgs?: boolean;
  /**
   * When true, run decodeHtmlEntities on every string argument before passing
   * it to the backend. Required for the remote HTTP server (HTML entities can
   * arrive from some MCP clients); leave false for the in-process plugin.
   */
  decodeHtml?: boolean;
  /**
   * Called when `obsidian_read_note` served a note WHOLE with `full: true`
   * and a rev (#443): the transport remembers (path, rev) so a whole-note
   * overwrite conditioned on that rev can pass. Sampled before the content is
   * read, like the rev itself.
   */
  onWholeRead?: (path: string, token: string) => void;
  /**
   * Called when a CUT read of a note is served (#443): the transport forgets
   * a whole read of that path, since the text the caller now holds may be
   * the cut one.
   */
  onCutRead?: (path: string) => void;
  /**
   * The token a whole read is remembered under (#443), sampled ONCE, before
   * the content is read, together with the rev the response shows — so the
   * two cannot come from different states of the note. Absent ⇒ nothing is
   * remembered (`onWholeRead` is never called): the token's spelling is
   * `wholeReadToken`'s, and a bare rev would never match it.
   */
  wholeToken?: (path: string) => { token: string; rev?: number } | undefined;
  /**
   * The operator's attachment list (the move list), read per call: `obsidian_read_note` treats a
   * file of one of these types, or of a type on core's default list, as binary and returns no
   * content for it (the backend's `binaryInfo`). Absent ⇒ the default list only.
   */
  binaryExtensions?: () => readonly string[];
  /**
   * When provided, the return value is merged into every read-tool response as
   * `index_status`. Also read before/after for obsidian_force_reindex timing.
   */
  includeIndexStatus?: () => IndexStatusSnapshot;
  /**
   * Revision token for a note, cheap and synchronous (the host's mtime in ms).
   * When provided, note reads carry the target's current `rev`, which the
   * caller hands back as `if_rev` on a following write — the read half of
   * optimistic concurrency. Omitted (or returning undefined) ⇒ no `rev` field,
   * exactly as before.
   */
  rev?: (path: string) => number | string | undefined;
  /**
   * Serialize a frontmatter object to YAML, for `obsidian_write_note`'s
   * `frontmatter` argument (#500): `obsidian.stringifyYaml` on the live host,
   * the same serializer `obsidian_write_notes` uses. Absent ⇒ `jsonFlowYaml`.
   */
  stringifyYaml?: (obj: Record<string, unknown>) => string;
  /**
   * The connection profile (profile.ts, #521). A tool outside it is not registered, and the
   * handler of one inside it keeps a call-time check (the profile's own write scope for a write).
   * Absent ⇒ `full`, as before. The plugin needs none: its patched registerTool filters every
   * registration, these included; the file-system server passes it here.
   */
  profile?: ConnProfile;
  /**
   * The secret scanner for this connection (redaction.ts's `scannerFor`), or absent (the default:
   * replies are sent as they are). Off unless the deployment named this connection's profile.
   */
  scanner?: SecretScanner;
  /** Whether a vault-relative path exists, for the profile's create-only check. Absent ⇒ every path reads as existing, so a profile write is refused. */
  exists?: (path: string) => boolean;
  /**
   * The operator's message config (send-message.ts). Set ⇒ `vaultmcp_send_message` is registered too
   * (when the profile offers it); absent ⇒ no such tool. The file-system server passes
   * `messageConfigFromEnv()`; the plugin passes nothing.
   */
  message?: MessageConfig;
  /** Test seam: the sender `vaultmcp_send_message` uses. Absent ⇒ the process-wide one. */
  messageSender?: MessageSender;
}

/**
 * Minimal duck-type for McpServer.registerTool — satisfied structurally by the
 * real McpServer from @modelcontextprotocol/sdk without importing it here.
 */
/**
 * The kernel arguments, named on every strict write tool here (#546 review). The plugin adds its own,
 * fuller copies with `withKernelArgs`; the file-system server has no kernel and nothing else names
 * them, so without these a strict write tool there would refuse an `idempotency_key` a client sends
 * because the plugin requires it. On that server they are accepted and not checked, as before.
 */
const KERNEL_ARGS_FS = {
  if_rev: z.number().optional().describe("The note's rev from a read. Checked by the Obsidian plugin's kernel; the file-system server does not check it."),
  idempotency_key: z.string().min(1).max(200).optional().describe("A retry-safety key. Honoured by the Obsidian plugin's kernel; the file-system server does not deduplicate."),
  intent: z.string().min(1).max(2000).optional().describe("Advisory text for the journal. Recorded by the Obsidian plugin; the file-system server does not record it."),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolRegistrar = { registerTool(name: string, meta: any, handler: (args: any) => any): any };

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Register all 17 FS_TOOLS on `server` using `backend` as the implementation.
 *
 * The schemas (name / title / description / inputSchema / annotations) come
 * exclusively from FS_TOOLS — no inline duplication. Handlers shape responses
 * to match the remote server's pre-existing public contract.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerFsTools(server: any, backend: VaultBackend, opts: RegisterFsToolsOpts = {}): void {
  const reg = server as ToolRegistrar;
  const { decodeHtml = false, kernelArgs = false, includeIndexStatus, rev, onWholeRead, wholeToken, onCutRead, stringifyYaml = jsonFlowYaml, binaryExtensions } = opts;

  const dec = (s: string): string => (decodeHtml ? decodeHtmlEntities(s) : s);

  const profile = opts.profile;
  for (const tool of FS_TOOLS) {
    if (profile && !profileAllows(profile, tool.name)) continue;
    const inner = makeHandler(tool.name, backend, dec, includeIndexStatus, rev, onWholeRead, wholeToken, onCutRead, stringifyYaml, binaryExtensions);
    const mutating = tool.annotations?.readOnlyHint === false;
    const gated = profile
      ? (args: any) => {
          // Check the arguments the handler will USE (#562 review 1): with decodeHtml on, the handler
          // decodes `&#47;` to `/`, so a check on the raw text could pass a path that leaves the scope.
          const seen = decodeHtml ? decodeArgsDeep(args, dec) : args;
          const refused = profileCallRefusal(profile, tool.name, mutating, seen, opts.exists ?? (() => true));
          return refused ? fail(Object.assign(new Error(refused.message), { code: refused.code })) : inner(args);
        }
      : inner;
    // When the deployment turned the secret scanner on for this connection's profile (redaction.ts),
    // every reply passes through it; the arguments and anything written to disk are unchanged.
    // Search hits carry single lines, so their snippets get the snippet rules too.
    const handler = opts.scanner ? opts.scanner.wrap(gated, { snippets: SNIPPET_TOOLS.has(tool.name) }) : gated;
    reg.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Every WRITE tool refuses an argument it does not name (#510, Nelson's pick A of 2026-10-12): a dropped
        // argument on a write is how two notes lost their frontmatter on 2026-10-09. Reads keep the SDK's
        // lenient object until someone asks for them; `strictArgs` still makes a read strict by hand.
        inputSchema:
          tool.annotations?.readOnlyHint === false
            ? strictInput({ ...(kernelArgs ? KERNEL_ARGS_FS : {}), ...tool.inputSchema })
            : tool.strictArgs
              ? strictInput(tool.inputSchema)
              : tool.inputSchema,
        annotations: tool.annotations,
      },
      handler,
    );
  }
  // The message tool's replies pass through the same scanner, so every reply on the connection does.
  const scanner = opts.scanner;
  const msgReg: ToolRegistrar = scanner ? { registerTool: (name, meta, h) => reg.registerTool(name, meta, scanner.wrap(h)) } : reg;
  registerSendMessageTool(msgReg, opts.message, { profile, ...(opts.messageSender ? { sender: opts.messageSender } : {}) });
}

// ── Per-tool handler factory ──────────────────────────────────────────────────

function makeHandler(
  name: string,
  backend: VaultBackend,
  dec: (s: string) => string,
  includeIndexStatus: (() => IndexStatusSnapshot) | undefined,
  revOf?: (path: string) => number | string | undefined,
  onWholeRead?: (path: string, token: string) => void,
  wholeToken?: (path: string) => { token: string; rev?: number } | undefined,
  onCutRead?: (path: string) => void,
  stringifyYaml: (obj: Record<string, unknown>) => string = jsonFlowYaml,
  binaryExtensions?: () => readonly string[],
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    includeIndexStatus ? { ...extra, index_status: includeIndexStatus() } : extra;

  /**
   * `{ rev }` for a path, or `{}` when the host supplies no revision source (or
   * has none for this path). Additive: a caller that ignores `rev` sees the
   * response it always saw.
   */
  const revField = (path: string): { rev?: number | string } => {
    const r = revOf?.(path);
    return r === undefined ? {} : { rev: r };
  };

  switch (name) {
    // ── obsidian_list_notes ────────────────────────────────────────────────
    case "obsidian_list_notes":
      return async ({ subdir, limit, offset }: { subdir?: string; limit: number; offset: number }) => {
        try {
          const decodedSubdir = subdir ? dec(subdir) : undefined;
          const { total, notes } = await backend.listNotes(decodedSubdir, limit, offset);
          return ok(status({
            total,
            count: notes.length,
            offset,
            notes,
            has_more: offset + notes.length < total,
          }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_list_folders ──────────────────────────────────────────────
    case "obsidian_list_folders":
      return async ({ subdir }: { subdir?: string }) => {
        try {
          const decoded = subdir ? dec(subdir) : undefined;
          const folders = await backend.listFolders(decoded);
          return ok({ subdir: decoded ?? null, count: folders.length, folders });
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_read_note ─────────────────────────────────────────────────
    case "obsidian_read_note":
      return async ({ path: p, full }: { path: string; full?: boolean }) => {
        try {
          const decoded = dec(p);
          // A binary file (an attachment type, or NUL bytes) is never read out as text: its rev and
          // size only, with or without `full`. A note is never asked (the check is for other files).
          if (backend.binaryInfo && !decoded.toLowerCase().endsWith(".md")) {
            const revd = revField(decoded);
            const info = await backend.binaryInfo(decoded, binaryExtensions?.() ?? []);
            if (info) return ok(status({ path: decoded, ...revd, size: info.size, binary: true }));
          }
          // rev is sampled BEFORE the content, so a write racing this read can
          // only make the returned rev too OLD — the caller's later `if_rev`
          // then conflicts. Sampling after would hand back a rev newer than the
          // content returned, and that write would silently clobber the racer.
          if (full) {
            // The whole note, never cut (#443). The token it is remembered
            // under and the rev the response shows are sampled HERE, once,
            // before the content: a racing write makes them too old, never
            // too new, and they can never disagree with each other.
            if (!backend.readNoteWhole) return fail(new Error("this server cannot read a note whole (full: true): the backend has no whole read"));
            const sampled = wholeToken ? wholeToken(decoded) : undefined;
            const revd = sampled ? (sampled.rev === undefined ? {} : { rev: sampled.rev }) : revField(decoded);
            const whole = await backend.readNoteWhole(decoded);
            if (sampled) onWholeRead?.(decoded, sampled.token);
            return ok(status({ path: decoded, content: whole, ...revd, truncated: false, whole: true }));
          }
          const revd = revField(decoded);
          const content = await backend.readNote(decoded);
          // `truncated` flags a cut read (truncation.ts) and is always
          // present, as on obsidian_read_notes; a cut read keeps its rev (#441).
          const truncated = isCutRead(content, CHARACTER_LIMIT);
          if (truncated) onCutRead?.(decoded);
          return ok(status({ path: decoded, content, ...revd, truncated }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_read_notes ────────────────────────────────────────────────
    case "obsidian_read_notes":
      return async ({ paths }: { paths: string[] }) => {
        type Result =
          | { idx: number; kind: "ok"; value: { path: string; content: string; truncated: boolean; rev?: number | string } }
          | { idx: number; kind: "err"; value: { path: string; error: string } };

        // Preserve input order even when duplicate paths are provided.
        const results: Result[] = await Promise.all(
          paths.map(async (raw, idx): Promise<Result> => {
            const p = dec(raw);
            try {
              // Sampled before the read, for the same reason as obsidian_read_note.
              const revd = revField(p);
              const content = await backend.readNote(p);
              // The cut is flagged as in obsidian_read_note (truncation.ts).
              const truncated = isCutRead(content, CHARACTER_LIMIT);
              if (truncated) onCutRead?.(p);
              return {
                idx,
                kind: "ok",
                value: { path: p, content, truncated, ...revd },
              };
            } catch (e) {
              return { idx, kind: "err", value: { path: p, error: e instanceof Error ? e.message : String(e) } };
            }
          })
        );
        results.sort((a, b) => a.idx - b.idx);
        const notes = results
          .filter((r): r is Extract<Result, { kind: "ok" }> => r.kind === "ok")
          .map((r) => r.value);
        const errors = results
          .filter((r): r is Extract<Result, { kind: "err" }> => r.kind === "err")
          .map((r) => r.value);
        return ok(status({ count: notes.length, error_count: errors.length, notes, errors }));
      };

    // ── obsidian_search_notes ──────────────────────────────────────────────
    case "obsidian_search_notes":
      return async ({ query, limit, mode }: { query: string; limit: number; mode: "one_per_note" | "all" }) => {
        try {
          const decodedQuery = dec(query);
          const hits = await backend.searchNotes(decodedQuery, limit, mode);
          return ok(status({ query: decodedQuery, mode, count: hits.length, hits }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_find_by_tag ───────────────────────────────────────────────
    case "obsidian_find_by_tag":
      return async ({ tag, limit }: { tag: string; limit: number }) => {
        try {
          const decodedTag = dec(tag);
          const notes = await backend.findByTag(decodedTag, limit);
          return ok(status({
            tag: decodedTag.replace(/^#/, ""),
            count: notes.length,
            notes,
          }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_search_by_frontmatter ─────────────────────────────────────
    case "obsidian_search_by_frontmatter":
      return async ({ property, value, limit }: { property: string; value: string; limit: number }) => {
        try {
          const decodedValue = dec(value);
          // Backend returns all matches uncapped; we apply the limit here.
          const matches = await backend.searchByFrontmatter(property, decodedValue);
          const notes = matches.slice(0, limit).map((n) => ({ path: n.path }));
          return ok(status({
            property,
            value: decodedValue,
            total: matches.length,
            count: notes.length,
            notes,
            has_more: matches.length > limit,
          }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_resolve ───────────────────────────────────────────────────
    case "obsidian_resolve":
      return async ({ refs, from }: { refs: string[]; from?: string }) => {
        // `from` is forwarded to backend.resolve so the live Obsidian backend can
        // pass it to getFirstLinkpathDest for context-sensitive disambiguation.
        // The filesystem backend accepts but ignores it (best-effort).
        try {
          const decoded = refs.map(dec);
          const decodedFrom = from ? dec(from) : undefined;
          const results = await backend.resolve(decoded, decodedFrom);
          const resolved = results.filter((r) => r.path !== undefined);
          const ambiguous = results.filter((r) => r.ambiguous !== undefined);
          const unresolved = results.filter((r) => r.path === undefined && r.ambiguous === undefined);
          return ok(status({ resolved, ambiguous, unresolved }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_get_backlinks ─────────────────────────────────────────────
    case "obsidian_get_backlinks":
      return async ({ path: p }: { path: string }) => {
        try {
          const decoded = dec(p);
          const backlinks = await backend.getBacklinks(decoded);
          return ok(status({ path: decoded, count: backlinks.length, backlinks }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_get_outlinks ──────────────────────────────────────────────
    case "obsidian_get_outlinks":
      return async ({ path: p }: { path: string }) => {
        try {
          const decoded = dec(p);
          const outlinks = await backend.getOutlinks(decoded);
          return ok(status({ path: decoded, count: outlinks.length, outlinks }));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_force_reindex ─────────────────────────────────────────────
    case "obsidian_force_reindex":
      return async () => {
        if (!includeIndexStatus) {
          // Live-cache path (Obsidian plugin): no persistent index to rebuild;
          // forceReindex() is a no-op. Return a truthful shape that says so.
          const t0 = Date.now();
          await backend.forceReindex();
          return ok({ status: "live", duration_ms: Date.now() - t0 });
        }
        // FS server path: real rebuild with before/after counts.
        const before = includeIndexStatus();
        const t0 = Date.now();
        await backend.forceReindex();
        const after = includeIndexStatus();
        return ok({
          status: after.status,
          prev_count: before.count,
          count: after.count,
          duration_ms: Date.now() - t0,
          last_built_at: after.last_built_at,
          error: after.error,
        });
      };

    // ── obsidian_manage_frontmatter ────────────────────────────────────────
    case "obsidian_manage_frontmatter":
      return async ({
        path: p,
        key,
        op,
        value,
      }: {
        path: string;
        key: string;
        op: "get" | "set" | "delete";
        value?: FrontmatterEditValue;
      }) => {
        try {
          const decodedPath = dec(p);
          if (op === "get") {
            const r = await backend.manageFrontmatter(decodedPath, key, "get");
            return ok({ path: decodedPath, key, op, value: r.value });
          }
          if (op === "delete") {
            const r = await backend.manageFrontmatter(decodedPath, key, "delete");
            return ok({ path: decodedPath, key, op, existed: r.existed, previous: r.previous });
          }
          // op === "set"
          if (value === undefined) {
            return fail(new Error("`value` is required for op='set'"));
          }
          const r = await backend.manageFrontmatter(decodedPath, key, "set", value);
          return ok({
            path: decodedPath,
            key,
            op,
            value,
            previous: r.previous,
            created_frontmatter: r.created_frontmatter,
          });
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_patch_note ────────────────────────────────────────────────
    case "obsidian_patch_note":
      return async ({
        path: p,
        anchor_type,
        anchor,
        op,
        content,
        whole_section,
      }: {
        path: string;
        anchor_type: "heading" | "block";
        anchor: string;
        op: "append" | "prepend" | "replace";
        content: string;
        whole_section?: boolean;
      }, extra?: { provenWhole?: boolean }) => {
        try {
          const decodedPath = dec(p);
          // Block IDs must be alphanumeric + dash/underscore by Obsidian convention.
          if (anchor_type === "block" && !/^[A-Za-z0-9_-]+$/.test(anchor)) {
            return fail(new Error(`Block anchor must match [A-Za-z0-9_-]+. Got: '${anchor}'`));
          }
          // `extra.provenWhole` is the host guard's word, decided at dequeue
          // (#443): the caller read this note whole on this connection at
          // the rev it conditioned on. Only the guard sets it.
          const result = await backend.patchNote(
            decodedPath,
            { type: anchor_type, value: anchor },
            op,
            content,
            { rangeRuleStandsAside: extra?.provenWhole === true, wholeSection: whole_section === true },
          );
          return ok({ path: decodedPath, ...result });
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_write_note ────────────────────────────────────────────────
    case "obsidian_write_note":
      return async ({ path: p, content, overwrite, frontmatter }: { path: string; content: string; overwrite: boolean; frontmatter?: Record<string, unknown> }) => {
        try {
          // #500: `frontmatter` is composed with `content` as its body, as
          // obsidian_write_notes composes an item. A body that opens with its
          // own fence would give the note two, so that is refused.
          if (frontmatter !== undefined && Object.keys(frontmatter).length > 0 && opensWithFrontmatter(content)) {
            throw new Error(
              "`content` opens with its own frontmatter fence and `frontmatter` was also given; nothing was written. " +
                "Pass the frontmatter one way: inside `content`, or as `frontmatter` with `content` as the body.",
            );
          }
          const text = frontmatter === undefined ? content : renderNoteWithFrontmatter(frontmatter, content, stringifyYaml);
          return ok(await backend.writeNote(dec(p), text, overwrite));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_append_note ───────────────────────────────────────────────
    case "obsidian_append_note":
      return async ({ path: p, content }: { path: string; content: string }) => {
        try {
          return ok(await backend.appendNote(dec(p), content));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_move_note ─────────────────────────────────────────────────
    case "obsidian_move_note":
      return async ({
        from,
        to,
        update_backlinks,
        overwrite,
      }: {
        from: string;
        to: string;
        update_backlinks: boolean;
        overwrite: boolean;
      }) => {
        try {
          const decodedFrom = dec(from);
          const decodedTo = dec(to);
          const r = await backend.moveNote(decodedFrom, decodedTo, { update_backlinks, overwrite });
          // Backlink count fields are number|null. null means "backend performed the
          // operation but cannot determine the count" (e.g. the live Obsidian backend
          // once used renameFile, which rewrote backlinks without a count). Omit null fields
          // rather than emitting a misleading 0.
          const resp: Record<string, unknown> = { from: r.from, to: r.to, moved: true };
          if (r.backlinks_updated !== null) resp.backlinks_updated = r.backlinks_updated;
          if (r.backlinks_files_touched !== null) resp.backlinks_files_touched = r.backlinks_files_touched;
          // The live host checks its own backlink rewrite for damage and says what it found.
          if (r.link_check !== undefined) resp.link_check = r.link_check;
          // A note the written-content guard refused is left unchanged and named, with the reason (#614).
          if (r.backlinks_skipped !== undefined) resp.backlinks_skipped = r.backlinks_skipped;
          return ok(status(resp));
        } catch (e) {
          return fail(e);
        }
      };

    // ── obsidian_delete_note ───────────────────────────────────────────────
    case "obsidian_delete_note":
      return async ({ path: p, confirm }: { path: string; confirm: true }) => {
        try {
          const decodedPath = dec(p);
          const r = await backend.deleteNote(decodedPath, confirm);
          return ok(r);
        } catch (e) {
          return fail(e);
        }
      };

    default:
      // Should never happen if FS_TOOLS is in sync with this switch.
      throw new Error(`registerFsTools: no handler for tool "${name}"`);
  }
}

/** Decode every string in an argument tree, as the handlers do one by one (#562 review 1). */
function decodeArgsDeep(v: unknown, dec: (s: string) => string, depth = 0): unknown {
  if (depth > 20) return v;
  if (typeof v === "string") return dec(v);
  if (Array.isArray(v)) return v.map((x) => decodeArgsDeep(x, dec, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = decodeArgsDeep(x, dec, depth + 1);
    return out;
  }
  return v;
}
