// Ported from Forge (github.com/nelsonlove/forge, commit d9f6704, src/shapes/headings.ts).
// MIT licence, copyright (c) 2026 Joshua Walls: the notice is in ./LICENSE and travels with this code.
// Changes for the conformance rail: import paths only.

/**
 * One heading scanner, shared by every caller that needs to know where a note's
 * headings are.
 *
 * A `#` at the start of a line is not always a heading. Markdown says a fenced code
 * block is opaque, and Obsidian says a `%%` comment is invisible. Scanning line by line
 * with a bare regex ignores both, so a shell comment in a code block becomes an H1, and
 * Forge then treats it as a document section: it can be matched by a template node,
 * counted as an extra heading, or used as a boundary when Shape Repair decides where to
 * insert. Measured on one real vault, 59 notes had at least one heading-shaped line
 * inside a fence.
 *
 * The rules here are CommonMark's for fences and Obsidian's for comments:
 *
 *   - A fence opens on three or more backticks or tildes and closes on a run of the same
 *     character at least as long. A shorter run inside a longer fence is content, which
 *     is how a markdown example shows fenced code without ending its own block.
 *   - A closing fence carries no info string, so ```md opens and a bare ``` closes.
 *   - `%%` toggles an Obsidian comment. A line holding a complete `%% ... %%` comment
 *     stays balanced; an odd marker opens a block that runs to the next marker.
 */

export interface ScannedHeading {
  level: number;
  text: string;
  lineIndex: number;
}

const HEADING = /^(#{1,6})\s+(.+)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Is this line a fence opener? CommonMark forbids a backtick in a backtick fence's info
 * string — ```js``` is a paragraph, not an opener. Accepting it opened a fence that
 * never closed, losing every heading after it.
 */
function openingFence(line: string): string | null {
  const m = FENCE.exec(line);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return m[1];
}

/**
 * Comment-visible text of a line, and the comment state after it.
 *
 * `%%` toggles an Obsidian comment, but NOT inside an inline code span: `` `%%` `` is
 * literal, and treating it as a delimiter opened a comment that ran to end of file and
 * silently swallowed every heading below. That is worse than the phantom headings this
 * module exists to remove — it is unbounded, and Shape Repair then re-inserts the
 * "missing" headings into the note. Measured on one vault: nine notes lost headings,
 * five of them purely because they mentioned `%%` in inline code.
 *
 * Text outside comments is returned so a heading sharing its line with a comment —
 * `# Title %% draft %%` — is still a heading, as Obsidian renders it.
 */
function stripComments(line: string, inComment: boolean): { text: string; inComment: boolean } {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (!inComment && line[i] === "`") {
      // An inline code span is opaque: copy it whole rather than scanning inside it.
      const run = /^`+/.exec(line.slice(i))![0];
      const close = line.indexOf(run, i + run.length);
      if (close === -1) { out += line.slice(i); break; } // unclosed span — rest is literal
      out += line.slice(i, close + run.length);
      i = close + run.length;
      continue;
    }
    if (line.startsWith("%%", i)) { inComment = !inComment; i += 2; continue; }
    if (!inComment) out += line[i];
    i++;
  }
  return { text: out, inComment };
}

/**
 * Headings in `lines`, skipping fenced code blocks and `%%` comments.
 *
 * `lineIndex` is the index within `lines`, so a caller that has already split off
 * frontmatter gets offsets relative to the body it passed in.
 */
export function scanHeadings(lines: string[]): ScannedHeading[] {
  const headings: ScannedHeading[] = [];
  let fence: string | null = null;
  let inComment = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (fence !== null) {
      // Only a run of the same character, at least as long as the opener, closes it —
      // and a closing fence carries no info string.
      const close = FENCE.exec(line);
      if (
        close &&
        close[1][0] === fence[0] &&
        close[1].length >= fence.length &&
        close[2].trim() === ""
      ) {
        fence = null;
      }
      continue;
    }

    // Fences win over comments: a %% inside a code block is content, not a delimiter.
    if (!inComment) {
      const opener = openingFence(line);
      if (opener) { fence = opener; continue; }
    }

    const stripped = stripComments(line, inComment);
    inComment = stripped.inComment;

    const match = HEADING.exec(stripped.text);
    if (match) {
      headings.push({ level: match[1].length, text: match[2].trim(), lineIndex: index });
    }
  }

  return headings;
}

/** Splits leading YAML frontmatter off `lines`, returning the body and its offset. */
export function splitFrontmatterLines(
  lines: string[]
): { bodyLines: string[]; bodyStartLineIndex: number } {
  if (lines[0]?.trim() !== "---") return { bodyLines: lines, bodyStartLineIndex: 0 };
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === "---") {
      return { bodyLines: lines.slice(index + 1), bodyStartLineIndex: index + 1 };
    }
  }
  // An unterminated opener means the whole file reads as frontmatter, which is what the
  // scanner this replaced did. Treating it as body is the dangerous direction: for a
  // TEMPLATE it would promote a YAML comment line to a template heading, and Shape
  // Repair would then insert that line into every note claiming the shape.
  return { bodyLines: [], bodyStartLineIndex: 0 };
}

/** Headings in a whole note or template, frontmatter excluded, offsets absolute. */
export function scanHeadingsInContent(content: string): ScannedHeading[] {
  const lines = content.split("\n");
  const { bodyLines, bodyStartLineIndex } = splitFrontmatterLines(lines);
  return scanHeadings(bodyLines).map((heading) => ({
    ...heading,
    lineIndex: heading.lineIndex + bodyStartLineIndex,
  }));
}
