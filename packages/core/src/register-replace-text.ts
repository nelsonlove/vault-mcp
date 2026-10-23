// register-replace-text.ts — `obsidian_replace_text`, registered on both servers the way the file
// tools are: the live host passes its ObsidianBackend through its guarded registerTool (the guard,
// the kernel with if_rev, idempotency_key and the journal, the record guard, the Sync guard, the
// allowlist, the write scope and the connection profile), and the file-system server passes its
// write-kernel backend (queue and journal; if_rev and idempotency_key accepted and not checked, as
// for its note tools).
//
// A separate registrar, not an FS_TOOLS row: FS_TOOLS is the 17 note tools, and their count and
// schemas are pinned as such on both servers. The plan (what to replace, and what to refuse) is
// replace-text.ts; the write is the backend's own whole-note writeNote.

import { z } from "zod";
import { ok, fail } from "./responses.js";
import { strictInput } from "./strict-input.js";
import { decodeHtmlEntities } from "./fs-backend/vault.js";
import { profileAllows, profileCallRefusal, type ConnProfile } from "./profile.js";
import { REPLACE_TEXT_TOOL, REPLACE_MAX_SPANS, REPLACE_SPAN_CONTEXT, type ReplaceTextResult } from "./replace-text.js";

/** What a backend must do for obsidian_replace_text: plan with `planReplaceText`, then write the result through its own writeNote. */
export interface TextReplaceBackend {
  replaceText(
    relPath: string,
    old: string,
    replacement: string,
    opts: { all: boolean; rangeRuleStandsAside?: boolean },
  ): Promise<ReplaceTextResult>;
}

export interface RegisterReplaceTextOpts {
  /** As registerFsTools: decode HTML entities in the path argument (the remote server). `old` and `new` are note text and are never decoded. */
  decodeHtml?: boolean;
  /** As registerFsTools: name the kernel arguments on this strict tool, accepted and not checked (the file-system server). */
  kernelArgs?: boolean;
  /** The connection profile; the tool is outside every profile but `full`, and the handler checks again at call time. */
  profile?: ConnProfile;
  /** Whether a path exists, for the profile's create-only check. */
  exists?: (path: string) => boolean;
  /** The note's rev after the write (the host's mtime), returned as `rev` so a next edit can pass it as if_rev. Absent ⇒ no `rev` field. */
  rev?: (path: string) => number | string | undefined;
}

const KERNEL_ARGS_FS = {
  if_rev: z.number().optional().describe("The note's rev from a read. Checked by the Obsidian plugin's kernel; the file-system server does not check it."),
  idempotency_key: z.string().min(1).max(200).optional().describe("A retry-safety key. Honoured by the Obsidian plugin's kernel; the file-system server does not deduplicate."),
  intent: z.string().min(1).max(2000).optional().describe("Advisory text for the journal. Recorded by the Obsidian plugin; the file-system server does not record it."),
};

const DESCRIPTION =
  "Replace one exact piece of text in one note, and leave the rest of the note as written. `old` is matched exactly (no regex, no case folding, no newline normalisation), counted on the note's own text from left to right, and matches never overlap. " +
  "Found 0 times: refused with Error [no_match]. Found more than once: refused with Error [many_matches], which names the count and the lines, unless all: true, which replaces every match. Nothing is written on a refusal. " +
  "Line endings are the note's own: in a note with CRLF endings, an `old` that spans lines must use \"\\r\\n\" (the result's `line_endings` says which the note uses). A leading byte-order mark is never matched or removed. " +
  "Frontmatter: a match must lie wholly in the body, or wholly inside the YAML between the two '---' fences, never on a fence; after a replace inside the YAML the block must still parse as YAML properties; a note with no frontmatter does not gain one (Error [frontmatter_edit]). The note that would result goes through the same acceptance guard as obsidian_write_note, so a replace can never add, change or remove a `verified` entry or set an acceptance key (Error [accept_forbidden]). To change one property, prefer obsidian_manage_frontmatter. " +
  "A note longer than the read limit: a match that ends past the limit is refused (Error [truncated_read]) unless you read the note whole (obsidian_read_note with full: true, on the live Obsidian server) and pass that read's rev. `new` that carries the read trailer of a cut read is refused the same way. " +
  `The result gives \`count\`, and for each match (the first ${REPLACE_MAX_SPANS}) its \`offset\`, \`line\` and the text before and after, with ${REPLACE_SPAN_CONTEXT} characters of context on each side; on the live Obsidian server also the note's new \`rev\`. ` +
  "On the live Obsidian server this write requires both if_rev (the note's rev from your read) and idempotency_key (new for each intended replace, the same only on a retry). The note must exist; this tool never creates one. An argument this tool does not name is refused, never ignored.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolRegistrar = { registerTool(name: string, meta: any, handler: (args: any, extra?: any) => any): any };

/** Register obsidian_replace_text on `server`, driving `backend`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerReplaceTextTool(server: any, backend: TextReplaceBackend, opts: RegisterReplaceTextOpts = {}): void {
  const reg = server as ToolRegistrar;
  const profile = opts.profile;
  if (profile && !profileAllows(profile, REPLACE_TEXT_TOOL)) return;
  const dec = (s: string): string => (opts.decodeHtml ? decodeHtmlEntities(s) : s);
  reg.registerTool(
    REPLACE_TEXT_TOOL,
    {
      title: "Replace exact text in a note",
      description: DESCRIPTION,
      inputSchema: strictInput({
        ...(opts.kernelArgs ? KERNEL_ARGS_FS : {}),
        path: z.string().min(1).describe("Vault-relative path of an existing note, ending in .md, e.g. 'Projects/Plan.md'."),
        old: z.string().min(1).describe("The exact text to replace, as the note holds it (copy it from a read)."),
        new: z.string().describe("The text to put in its place. May be empty, to delete `old`."),
        all: z.boolean().default(false).describe("Replace every match. Default false: refused unless `old` is found exactly once."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    // `extra.provenWhole` is the host guard's word, decided at dequeue (#443): the caller read this
    // note whole on this connection at the rev it conditioned on. Only the guard sets it.
    async ({ path: p, old, new: replacement, all }: { path: string; old: string; new: string; all: boolean }, extra?: { provenWhole?: boolean }) => {
      const path = dec(p);
      if (profile) {
        const refused = profileCallRefusal(profile, REPLACE_TEXT_TOOL, true, { path }, opts.exists ?? (() => true));
        if (refused) return fail(Object.assign(new Error(refused.message), { code: refused.code }));
      }
      try {
        const result = await backend.replaceText(path, old, replacement, { all: all === true, rangeRuleStandsAside: extra?.provenWhole === true });
        const rev = opts.rev?.(path);
        return ok({ ...result, ...(rev === undefined ? {} : { rev }) });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
