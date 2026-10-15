// Ported from Forge (github.com/nelsonlove/forge, commit d9f6704, src/fileclass/shape-source.ts).
// MIT licence, copyright (c) 2026 Joshua Walls: the notice is in ./LICENSE and travels with this code.
// Changes for the conformance rail: import paths only.

/**
 * Class notes as a refinement source.
 *
 * A Fileclass class definition is the same artifact as a Forge shape note: a spec
 * document a human reads, with one marked region a machine compiles. Forge marks its
 * region with a `# Structure` section; a class note marks it with a fenced code block
 * under a `## Shape` heading:
 *
 *     ## Shape
 *
 *     ```md
 *     # {{TITLE}}
 *     ## Purpose
 *     ```
 *
 * The fence is deliberate, twice over. Its content is read *verbatim* — what you write
 * is the structure, at its own levels, no promotion — because fenced content stands
 * outside the note's own heading tree, so the wrapper never joins the parent chain the
 * way a plain section would. And nothing else can be mistaken for the contract: prose,
 * examples and other fences elsewhere in the note are never read.
 *
 * Only extraction lives here — two callers read the blocks it finds, and they read them
 * at different times. Refinement compiles a `## Shape` block into a template note, so a
 * class edit reaches lint only when refinement is deliberately run. Shape lint, with
 * `shapeSourceFileclass` on, reads the blocks itself at lint time: a class's `## Shape`
 * where it declares one, and otherwise a shape derived from its `## Template` fence, so
 * a class edit takes effect on the next lint with nothing generated in between.
 */

const ANY_HEADING = /^#{1,2}\s+\S/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionHeading(headingName: string): RegExp {
  return new RegExp(`^##\\s+${escapeRegex(headingName)}\\s*$`, "i");
}

/**
 * The fenced block under one H2 of a class note body, or null when the note has none.
 *
 * The rule, precisely: the first fenced code block that starts under the named H2,
 * before the next H1/H2 ends the section. An unclosed fence reads to the end of the
 * section rather than swallowing the rest of the note.
 *
 * `headingName` is which H2 to read. It defaults to `Shape`, the structure contract a
 * class declares outright. The other caller asks for `Template`, the body a new note is
 * born as, which is read the same way and then derived into a shape — see
 * `src/shapes/derive.ts`. Both blocks are fenced for the same two reasons: fenced
 * content stands outside the note's own heading tree, so it is read verbatim at the
 * levels written with no promotion, and nothing else in the note — prose, examples,
 * other fences — can be mistaken for the contract.
 */
export function extractShapeBlock(body: string, headingName = "Shape"): string | null {
  const heading = sectionHeading(headingName);
  const lines = body.split("\n");
  let inSection = false;
  let fence: string | null = null;
  const collected: string[] = [];

  // A fence seen while looking for the section heading. A `## Template` or `## Shape`
  // line inside another section's fence is that fence's content, not this section.
  let outerFence: string | null = null;

  for (const line of lines) {
    if (!inSection) {
      const marker = line.match(FENCE);
      if (outerFence !== null) {
        if (marker && marker[1][0] === outerFence[0] && marker[1].length >= outerFence.length && marker[2].trim() === "") {
          outerFence = null;
        }
        continue;
      }
      if (marker) {
        outerFence = marker[1];
        continue;
      }
      if (heading.test(line)) inSection = true;
      continue;
    }

    if (fence !== null) {
      const close = line.match(FENCE);
      if (
        close &&
        close[1][0] === fence[0] &&
        close[1].length >= fence.length &&
        close[2].trim() === ""
      ) {
        const text = collected.join("\n").trim();
        return text.length > 0 ? text : null;
      }
      collected.push(line);
      continue;
    }

    if (ANY_HEADING.test(line)) return null; // section ended before any fence

    const open = line.match(FENCE);
    if (open) fence = open[1];
  }

  if (fence !== null) {
    const text = collected.join("\n").trim();
    return text.length > 0 ? text : null;
  }
  return null;
}
