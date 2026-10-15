// Ported from Forge (github.com/nelsonlove/forge, commit d9f6704, src/shapes/derive.ts).
// MIT licence, copyright (c) 2026 Joshua Walls: the notice is in ./LICENSE and travels with this code.
// Changes for the conformance rail: import paths only.

/**
 * A shape derived from a class note's `## Template` fence.
 *
 * A class note carries two fenced blocks, and they answer different questions. The
 * `## Template` fence is what a new note is born as; the `## Shape` fence is what any
 * note claiming the class must still look like months later. Most classes only ever
 * need the first, because their template is already a list of literal headings and the
 * shape is that same list. Keeping both in step by hand is the drift this module
 * removes: where a class declares no `## Shape`, its shape is derived from its template
 * at lint time, in memory, and nothing is generated or stored.
 *
 * The two blocks cannot simply be equated, because a template RUNS and a shape MATCHES.
 * `# [{{TITLE}}]({{VALUE:url}})` produces `# [Some page](https://example.com)`, so a
 * shape holding that heading as a literal would match no note at all. The derivation is
 * therefore one pass that turns every generator in a heading line into the `{{…}}`
 * placeholder the matcher already understands (`headingTextMatches` in `identity.ts`),
 * and leaves every literal word alone.
 *
 * Where the derived shape would be wrong, a class declares an explicit `## Shape` and
 * that block wins outright — this module is never consulted for such a class.
 *
 * One difference is deliberate: a template's leading `# {{TITLE}}` is derived as an
 * optional heading, so a note without a title heading is checked at its top level
 * instead of being reported missing its title (see `deriveShapeHeadings`).
 */

import { extractShapeBlock } from "./shape-source.js";
import { scanHeadingsInContent } from "./headings.js";
import { hasHeadingPlaceholder } from "./identity.js";
import type { ParsedHeading } from "./match.js";

/** A leading YAML block. Stripped before the fences are read, as refinement does. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * An inline-code span holding a render rather than code.
 *
 * Meta-bind and js-engine put their renders in inline code: `` `VIEW[{title}][text]` ``,
 * `` `INPUT[…]` ``, `` `BUTTON[…]` ``. In a heading line the rendered output is the
 * heading's text, and that output differs per note, so the span is a generator and
 * becomes a placeholder. Any other code span is literal text a note is expected to
 * carry, and is left as written.
 */
const RENDER_SPAN = /^\s*(VIEW|INPUT|BUTTON)\s*\[/i;

/** A letter or a digit in any script — what "a literal word survives" means here. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

const PLACEHOLDER = /\{\{[^{}\r\n]+\}\}/g;

/**
 * Heading text with every render span replaced by a placeholder.
 *
 * Inline code is opaque, the way it is to the heading scanner: a span is copied whole
 * or replaced whole, never scanned into. A backtick run that never closes makes the
 * rest of the line literal, which is what Obsidian renders.
 */
function replaceRenderSpans(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      out += text[index];
      index += 1;
      continue;
    }

    const run = /^`+/.exec(text.slice(index))![0];
    const close = text.indexOf(run, index + run.length);
    if (close === -1) {
      out += text.slice(index); // unclosed span — the rest of the line is literal
      break;
    }

    const inner = text.slice(index + run.length, close);
    const render = RENDER_SPAN.exec(inner);
    out += render ? `{{${render[1].toUpperCase()}}}` : text.slice(index, close + run.length);
    index = close + run.length;
  }

  return out;
}

/**
 * One heading line of a template, as the shape that matches what it produces.
 *
 * The rule, in the three parts it was ruled in:
 *
 *   - A `{{TITLE}}`, `{{VALUE:…}}` or `{{date:…}}` token already is a placeholder and
 *     is kept exactly as written — the matcher turns each into a non-greedy wildcard.
 *   - A render span becomes a placeholder naming what it rendered.
 *   - Every literal word survives, so `Why it matters` derives as itself.
 *
 * And the clause that catches the common case: a heading that reduces to nothing but a
 * placeholder becomes `{{TITLE}}`. `# [{{TITLE}}]({{VALUE:url}})` keeps only brackets
 * once its tokens are set aside, and brackets are not a word, so the whole heading is a
 * wildcard. A heading carrying no placeholder at all is never collapsed, however little
 * of it is a word — `## ---` is a literal heading, not a generator.
 */
export function deriveShapeHeadingText(text: string): string {
  const derived = replaceRenderSpans(text).trim();
  if (!hasHeadingPlaceholder(derived)) return derived;

  const literal = derived.replace(PLACEHOLDER, "");
  return WORD_CHARACTER.test(literal) ? derived : "{{TITLE}}";
}

/**
 * The shape a class note's `## Template` fence implies.
 *
 * Only heading lines contribute. Everything else in the fence — the leading `---`
 * frontmatter block, prose, tables, inline views and nested `js-engine` blocks — says
 * nothing about a note's heading structure, and `scanHeadingsInContent` already skips
 * all of it: it splits leading frontmatter, treats a fenced block as opaque, and honours
 * `%%` comments. Levels are kept as written, because a template fence stands outside the
 * class note's own heading tree and is already rooted where it means to be.
 */
export function deriveShapeHeadings(templateBlock: string): ParsedHeading[] {
  const headings: ParsedHeading[] = [];

  for (const heading of scanHeadingsInContent(templateBlock)) {
    const text = deriveShapeHeadingText(heading.text);
    if (!text) continue;
    headings.push({ level: heading.level, text, lineIndex: heading.lineIndex });
  }

  // A template's leading title heading is not required of a note. Many notes carry no H1
  // (daily notes, imported batches), and their sections then sit at the top level; a
  // note that does carry one has its sections checked under it. Only the first heading,
  // and only an H1 that derives to the bare title wildcard, is made optional.
  const first = headings[0];
  if (first && first.level === 1 && first.text === "{{TITLE}}") first.optional = true;

  return headings;
}

/**
 * The shape one class note declares, and the precedence between its two fences.
 *
 * A non-empty `## Shape` wins, read verbatim and never derived — that block exists
 * precisely for the classes whose derived shape would be wrong, and deriving it again
 * would defeat the override. Only where a class declares no usable `## Shape` is its
 * `## Template` fence read and derived. A class with neither has no shape: it
 * contributes nothing and is not linted, which is honest but silent, so the count of
 * such classes belongs in a lint run's digest.
 *
 * Two edges are worth knowing, because both are quiet rather than loud.
 *
 * A `## Shape` heading with an EMPTY fence under it counts as no shape, not as "this
 * class has no structural contract" — `extractShapeBlock` returns null for an empty
 * fence, so the `## Template` fence is derived instead. That is deliberate consistency
 * with refinement, which has always read an empty fence as nothing to compile; a class
 * that means "no contract" says so by carrying neither fence.
 *
 * And a fence closes on the first run of its own character at least as long as its
 * opener, which is CommonMark's rule and the one the extractor follows. So a
 * three-backtick `## Template` fence containing a nested three-backtick block ends at
 * the nested block's closing line, and every heading after it is lost from the derived
 * shape. A class note that nests fences must open the outer one longer — ````md — as
 * the class notes that already nest do. The failure is a shape naming fewer headings
 * than it should, which reports nothing rather than reporting wrongly, so it is the safe
 * direction; it is still worth catching when a class is written.
 *
 * Takes the class note's whole text, leading frontmatter and all.
 */
export function shapeHeadingsForClassNote(note: string): ParsedHeading[] {
  const body = note.replace(FRONTMATTER, "");

  const declared = extractShapeBlock(body, "Shape");
  // Verbatim: an explicit shape is already written in the matcher's own terms.
  if (declared !== null) return scanHeadingsInContent(declared);

  const template = extractShapeBlock(body, "Template");
  return template === null ? [] : deriveShapeHeadings(template);
}
