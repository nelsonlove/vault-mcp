// Ported from Forge (github.com/nelsonlove/forge, commit d9f6704, src/shapes/lint.ts).
// MIT licence, copyright (c) 2026 Joshua Walls: the notice is in ./LICENSE and travels with this code.
//
// Changes for the conformance rail. The matcher (`buildTemplateTree`,
// `expandOptionalNodes`, the per-level match and the order check of `lintLevel`,
// `isReservedForFixedSibling`, `buildDocSectionTree`) is lifted out of Forge's
// lint service. What is left behind: `ForgeSettings`, Forge's `LintResult`
// envelope, ranges, severities, and the two checks the plan does not carry
// ("Replace the four Forge-only checks", check (a): "report each required
// heading the note is missing or has out of order"): extra headings and empty
// sections. The result is a plain list of gaps that the `shape` pack maps onto
// the conformance finding.

import { scanHeadings } from "./headings.js";
import { hasHeadingPlaceholder, headingTextMatches } from "./identity.js";

export interface ParsedHeading {
  level: number;
  text: string;
  lineIndex: number;
  /**
   * The heading need not be present. Set only by the derivation, on a template's leading
   * `# {{TITLE}}` (see `deriveShapeHeadings`): a note that carries a title heading has its
   * sections checked under it, and a note that carries none has them checked at the top.
   */
  optional?: boolean;
}

export interface TemplateNode {
  text: string;
  level: number;
  children: TemplateNode[];
  optional?: boolean;
}

/** One gap between a note and a shape. `parent` is the template heading the gap sits under (null = the top level). */
export type ShapeGap =
  | { kind: "missing"; level: number; text: string; parent: string | null }
  | { kind: "order"; parent: string | null; expected: string[] };

interface DocSection {
  headingText: string;
  headingLevel: number;
  children: DocSection[];
}

export function buildTemplateTree(headings: ParsedHeading[]): TemplateNode[] {
  const roots: TemplateNode[] = [];
  const stack: TemplateNode[] = [];

  for (const heading of headings) {
    const node: TemplateNode = { text: heading.text, level: heading.level, children: [] };
    if (heading.optional) node.optional = true;

    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return roots;
}

/**
 * Template nodes as they apply to one level of a note: an optional node that no section
 * of that level matches is replaced by its children, so they are looked for where the
 * note has them, at that same level. A matched optional node stays, and its children are
 * looked for under the section it matched.
 */
export function expandOptionalNodes(
  templateNodes: TemplateNode[],
  sections: { headingText: string; headingLevel: number }[],
): TemplateNode[] {
  const out: TemplateNode[] = [];
  for (const node of templateNodes) {
    // The same test the matcher applies, including the fixed-sibling reservation: a
    // section a fixed sibling claims cannot be the title, so it does not make it present.
    const present =
      !node.optional ||
      sections.some(
        (section) =>
          section.headingLevel === node.level &&
          headingTextMatches(node.text, section.headingText) &&
          !templateNodes.some(
            (sibling) =>
              sibling !== node &&
              !hasHeadingPlaceholder(sibling.text) &&
              sibling.level === section.headingLevel &&
              headingTextMatches(sibling.text, section.headingText),
          ),
      );
    if (present) out.push(node);
    else out.push(...expandOptionalNodes(node.children, sections));
  }
  return out;
}

function isReservedForFixedSibling(templateNode: TemplateNode, siblings: TemplateNode[], section: DocSection): boolean {
  if (!hasHeadingPlaceholder(templateNode.text)) return false;
  return siblings.some(
    (sibling) =>
      sibling !== templateNode &&
      !hasHeadingPlaceholder(sibling.text) &&
      sibling.level === section.headingLevel &&
      headingTextMatches(sibling.text, section.headingText),
  );
}

function buildDocSectionTree(bodyLines: string[]): DocSection[] {
  const roots: DocSection[] = [];
  const stack: DocSection[] = [];
  for (const heading of scanHeadings(bodyLines)) {
    const section: DocSection = { headingText: heading.text, headingLevel: heading.level, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].headingLevel >= section.headingLevel) stack.pop();
    if (stack.length === 0) roots.push(section);
    else stack[stack.length - 1].children.push(section);
    stack.push(section);
  }
  return roots;
}

function matchLevel(templateNodes: TemplateNode[], docSections: DocSection[], parentText: string | null, gaps: ShapeGap[]): void {
  templateNodes = expandOptionalNodes(templateNodes, docSections);
  const consumed = new Set<DocSection>();
  const matchedSections = new Map<TemplateNode, DocSection>();

  for (const templateNode of templateNodes) {
    const match = docSections.find(
      (section) =>
        !consumed.has(section) &&
        headingTextMatches(templateNode.text, section.headingText) &&
        section.headingLevel === templateNode.level &&
        !isReservedForFixedSibling(templateNode, templateNodes, section),
    );
    if (!match) {
      gaps.push({ kind: "missing", level: templateNode.level, text: templateNode.text, parent: parentText });
    } else {
      consumed.add(match);
      matchedSections.set(templateNode, match);
      matchLevel(templateNode.children, match.children, templateNode.text, gaps);
    }
  }

  const docOrder = docSections
    .filter((section) => consumed.has(section))
    .map(
      (section) =>
        [...matchedSections.entries()].find(([, matchedSection]) => matchedSection === section)?.[0].text.toLowerCase() ?? "",
    );
  const expectedOrder = templateNodes.map((n) => n.text.toLowerCase()).filter((text) => docOrder.includes(text));
  const same = docOrder.length === expectedOrder.length && docOrder.every((v, i) => v === expectedOrder[i]);
  if (!same && expectedOrder.length > 1) gaps.push({ kind: "order", parent: parentText, expected: expectedOrder });
}

/** A note's body lines: Forge's lint-side split (lint.ts `splitFrontmatter`), kept for parity.
 * Unlike the template-side split in headings.ts, an UNTERMINATED opener leaves every line in
 * the body, so a note with a broken fence is still checked rather than read as empty. */
function noteBodyLines(lines: string[]): string[] {
  if (lines[0]?.trim() !== "---") return lines;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === "---") return lines.slice(index + 1);
  }
  return lines;
}

/** The gaps between one note's text (frontmatter included) and one shape's headings. Pure. */
export function shapeGaps(noteText: string, shape: ParsedHeading[]): ShapeGap[] {
  if (shape.length === 0) return [];
  const bodyLines = noteBodyLines(noteText.split("\n"));
  const gaps: ShapeGap[] = [];
  matchLevel(buildTemplateTree(shape), buildDocSectionTree(bodyLines), null, gaps);
  return gaps;
}
