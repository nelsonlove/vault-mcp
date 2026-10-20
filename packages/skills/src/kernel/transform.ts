// Pure vault → Claude Code plugin transform (frontmatter tree model).
//
// A note declares `type` (skill|agent) and `parent` ([[wikilink]]s, resolved to paths by the
// caller). The FIRST parent is PRIMARY — it is the tree edge, and it alone drives breadcrumb,
// level, ownership and the depth checks. Any further parents are recorded ATTACHMENTS: a
// second organizational/provenance edge, reported by the validate/preview surfaces, that
// changes nothing about where the compiled file lands (the output is flat:
// `skills/<name>/SKILL.md`, `agents/<name>.md`, and the generated name comes from the note's
// own name). Every named parent is still validated — it must resolve and it must be an agent.
//
// The compiled `skills:` frontmatter on an agent is PRELOAD, not permission: per Claude Code's
// subagent docs it "controls which skills are preloaded, not which skills the subagent can
// access", and unlisted skills stay invokable through the Skill tool. So it is emitted from an
// OPT-IN per-skill `preload: true` (over that skill's attached agents), not from attachment —
// preloading a whole scope would spend the fresh context window delegation exists to provide.
// A per-agent `no-skills: true` emits the one real boundary the platform offers
// (`disallowedTools: [Skill]`). See docs/README.md.
//
// `type: command` notes are flat — they take no part in the tree (no parent, no ownership) and
// emit a Claude Code slash command at `commands/<name>.md`. `type: policy` bodies are injected
// into agents.
//
// No `obsidian`/`fs` imports — unit-testable. Parent wikilinks are resolved to note paths by
// exporter.ts (Obsidian); this module works purely on those paths.

import { transclusionOpen } from "./transclude.js"; // marker format single-sourced (pure module)

/** Tree kinds — participate in the parent/ownership tree. */
export type Kind = "skill" | "agent";
/** Everything the transform emits as a file (commands are flat, outside the tree). */
export type EmittedKind = Kind | "command";

export interface NoteInput {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** Resolved parent note path(s). 0 ⇒ child of root; otherwise the FIRST is the primary
   *  parent (the tree edge) and the rest are recorded attachments. All are validated. */
  parentPaths: string[];
  /** Vault paths of notes transcluded (inlined) into `body`, all depths — provenance for
   *  the compiled artifact. Populated by the collector; the transform passes it through. */
  sources?: string[];
}

export interface Generated {
  kind: EmittedKind;
  relOut: string;
  content: string;
  from: string;
  /** Generated (deduped) name — the Claude Code listing name. Absent on static files. */
  name?: string;
  /** The listing description exactly as emitted (breadcrumbed for tree nodes). */
  description?: string;
  /** Vault paths of every note transcluded into this file's content (the emitting note's
   *  own embeds, plus — for agents — embeds inside its injected policy bodies). Present
   *  only when non-empty. */
  sources?: string[];
}

export interface TransformOptions {
  pluginName: string;
  synthesizeRoot?: boolean;
  /** Absolute vault path, baked into each agent so it can read/write the vault. */
  vaultPath?: string;
  /** How many skills may be preloaded into ONE agent before the compile warns. Not a
   *  refusal — the vault decides — but past a handful, preloading spends the fresh
   *  context window instead of leaving skills to on-demand discovery. */
  preloadCap?: number;
  /** Each accepted source's human verification (01.61 rule 11: the compiled
   *  artifact records each source's acceptance state), filled at collect time
   *  by the exporter's gate. Absent (a bare transform, as the transform's own
   *  tests call it) ⇒ no acceptance block is written. */
  acceptance?: ReadonlyMap<string, { by: string; at: string | null }>;
  /** The embed targets the gate REFUSED this run. A refused path reads NOT
   *  accepted whatever the map says, so the record follows what was actually
   *  inlined even if the note gate and the embed gate ever read one note
   *  differently (a backend with no cache parses embeds from raw text). */
  refused?: ReadonlySet<string>;
}

/** Default {@link TransformOptions.preloadCap} — also the skills module's config default. */
export const DEFAULT_PRELOAD_CAP = 5;

export interface TreeNode {
  name: string;            // generated name
  kind: Kind;              // agent | skill
  parent: string | null;  // primary parent agent's generated name (null for the root)
  level: number;
  skills: string[];        // owned skills' generated names (agents only)
  children: string[];      // child agents' generated names (agents only)
  crosscutting: boolean;   // horizontal slot agent (fanned into scope agents' routing)
  /** Generated names of the non-primary parents this note also names (attachments).
   *  Omitted when there are none, so a single-parent tree reads exactly as before. */
  extraParents?: string[];
  /** Agents: generated names of the notes attached to it by a NON-primary parent edge —
   *  the other half of `extraParents`. Omitted when empty. */
  attached?: string[];
  /** Skills: `preload: true` — opted into being preloaded (`skills:`) on every agent it is
   *  attached to. Omitted when absent/false. */
  preload?: boolean;
  /** Agents: `no-skills: true` — compiled with `disallowedTools: [Skill]`. Omitted when off. */
  noSkills?: boolean;
}

/** A note that names more than one parent: the primary tree edge plus the extra
 *  (attachment) edges, as reported by the validate/preview surfaces. */
export interface Attachment {
  /** The attached note's generated name. */
  name: string;
  kind: Kind;
  path: string;
  /** Generated name of the primary parent — the tree edge. */
  primary: string | null;
  /** Generated names of the additional parents this note is attached to. */
  extra: string[];
  /** Skills only: whether it opted into preloading (`preload: true`). */
  preload: boolean;
}

/** What one agent's compiled `skills:` frontmatter ends up carrying. */
export interface PreloadPlacement {
  /** The agent's generated name. */
  agent: string;
  path: string;
  /** Plugin-namespaced skill refs, exactly as emitted in `skills:`. */
  skills: string[];
  /** True when the set exceeds the configured cap (also reported as a warning). */
  overCap: boolean;
}

/** Where a policy note's body actually landed: the agents whose compiled files include it
 *  (lineage injection, plus `severity: hard` inlining into crosscutting agents). */
export interface PolicyPlacement {
  path: string;
  title: string;
  hard: boolean;
  agents: string[];
}

export interface TransformResult {
  generated: Generated[];
  warnings: string[];
  errors: string[];
  tree: TreeNode[];
  policies: PolicyPlacement[];
  /** Notes naming more than one parent — the multi-parent attachments, reported so a
   *  human can see which agents a shared skill is recorded against. */
  attachments: Attachment[];
  /** Per-agent preload sets: what each agent's `skills:` frontmatter carries. */
  preloads: PreloadPlacement[];
  /** The cap the preload sets were checked against (see {@link TransformOptions.preloadCap}). */
  preloadCap: number;
}

interface Node {
  kind: Kind;
  path: string;
  isRoot: boolean;
  parentPaths: string[];
  nameBase: string;
  id?: string;
  label: string;
  rawDesc: string;
  version?: string;
  tools?: string[];
  model?: string;
  crosscutting: boolean;
  slot?: string;
  /** Skills: `preload: true` — opt into being preloaded into every attached agent. */
  preload: boolean;
  /** Agents: `no-skills: true` — compile the Skill-tool lockout. */
  noSkills: boolean;
  extra: Record<string, unknown>;
  body: string;
  sources?: string[];
  // resolved:
  parent: Node | null;
  children: Node[];
  ownedSkills: Node[];
  /** Parents beyond the primary — attachment edges, no bearing on the tree. */
  extraParents: Node[];
  /** Agents: the notes attached to this agent by a non-primary parent edge. */
  attached: Node[];
  level: number;
  genName: string;
  valid: boolean;
}

interface Policy {
  path: string;
  parentPaths: string[];
  body: string;
  /** Note basename — display title in the generated scope-policy index. */
  title: string;
  /** `severity: hard` — compiled full-text into crosscutting agents, not just the subtree. */
  hard: boolean;
  /** Notes transcluded into the policy body — carried onto every agent it's injected into. */
  sources?: string[];
}

interface Command {
  path: string;
  nameBase: string;
  rawDesc: string;
  extra: Record<string, unknown>;
  body: string;
  genName: string;
  sources?: string[];
}

const SYNTH_ROOT_PATH = " synth-root";

/** The authored agent field that compiles the Skill-tool lockout (`disallowedTools: [Skill]`).
 *  Named here so the transform, the field-namespacing view in exporter.ts, and the docs can
 *  never disagree about its spelling. */
export const NO_SKILLS_FIELD = "no-skills";

/** The authored skill field that opts into preloading (`skills:` on every attached agent). */
export const PRELOAD_FIELD = "preload";

/** Documented SKILL.md frontmatter keys passed through verbatim from a skill note
 *  (Claude Code silently ignores unknown keys, so this is a curated allowlist rather
 *  than pass-everything — it keeps Obsidian housekeeping fields like `tags`/`aliases`
 *  out of the generated skill). `hooks` is excluded: it is a nested object and the
 *  flat YAML emitter here deliberately doesn't render nesting. */
export const SKILL_PASSTHROUGH_FIELDS = [
  "when_to_use", "argument-hint", "arguments",
  "disable-model-invocation", "user-invocable",
  "allowed-tools", "disallowed-tools",
  "model", "effort", "context", "agent", "paths", "shell",
] as const;

/** Claude Code slash-command frontmatter keys passed through verbatim from a `type: command`
 *  note (`description` is handled separately). Curated allowlist, same rationale as
 *  SKILL_PASSTHROUGH_FIELDS — keep Obsidian housekeeping fields out of the emitted command. */
export const COMMAND_PASSTHROUGH_FIELDS = [
  "argument-hint", "allowed-tools", "disallowed-tools", "model",
] as const;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Passthrough values must survive the flat YAML emitter: scalars and arrays of scalars only. */
const isScalar = (x: unknown): boolean => ["string", "number", "boolean"].includes(typeof x);

/** Collect an allowlisted set of frontmatter keys that are scalar (or scalar lists); anything
 *  nested is dropped with a warning, since the flat YAML emitter can't render it. */
function passthrough(
  fm: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  warnings: string[],
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const f of keys) {
    const v = fm[f];
    if (v == null) continue;
    if (isScalar(v) || (Array.isArray(v) && v.every(isScalar))) extra[f] = v;
    else warnings.push(`${path}: passthrough field \`${f}\` has a nested value — dropped (only scalars and lists of scalars are exported)`);
  }
  return extra;
}

/** Description fallback shared by skills/agents and commands: the note's `description`, else the
 *  name humanized (dashes → spaces). `nameBase` is the already-slugged name, so this reuses it
 *  rather than re-slugging. */
function descFallback(fm: Record<string, unknown>, nameBase: string): string {
  return (str(fm.description) || nameBase.replace(/-/g, " ")).trim();
}

/** Uniquify `base` against `used` (mutated), appending `-2`, `-3`, … on collision. Shared by the
 *  tree-node and command naming passes so both dedup the same `/plugin:<name>` namespace identically. */
function uniqueName(base: string, used: Set<string>): { name: string; collided: boolean } {
  const collided = used.has(base);
  let name = base, k = 2;
  while (used.has(name)) name = `${base}-${k++}`;
  used.add(name);
  return { name, collided };
}

function toolsArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

export function slug(s: string): string {
  return String(s).toLowerCase().trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toYaml(obj: Record<string, unknown>): string {
  const out = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (Array.isArray(v)) {
      const items = v.map(String);
      // Flow style is only safe when no item needs quoting; a comma inside an unquoted
      // flow item would split it into two on parse.
      if (items.some((e) => /[:#,]/.test(e))) {
        out.push(`${k}:`);
        for (const e of items) out.push(`  - ${/[:#"'\n,]/.test(e) ? JSON.stringify(e) : e}`);
      } else {
        out.push(`${k}: [${items.join(", ")}]`);
      }
    } else if (typeof v === "string") {
      const plain = /^[A-Za-z0-9][\w .,/()&-]*$/.test(v);
      out.push(`${k}: ${plain ? v : JSON.stringify(v)}`);
    } else out.push(`${k}: ${String(v)}`);
  }
  out.push("---");
  return out.join("\n");
}

/** An HTML comment ends at the first `-->` (or `--!>`); soften both in
 *  anything interpolated into one. */
const soft = (s: string): string => s.replace(/--(!?)>/g, "--$1›");

/** Attribution marker for an injected policy body — the compiled-output counterpart of the
 *  transclusion markers (see transclude.ts). */
function policyMarker(path: string): string {
  return `<!-- policy: ${soft(path)} -->`;
}

function provenanceFor(from: string, acceptance?: string[]): string {
  const tail = acceptance && acceptance.length ? `\n     acceptance:\n${acceptance.map((l) => `       ${l}`).join("\n")}` : "";
  return `<!-- generated by obsidian-vault-skills from vault note: ${soft(from)}\n     Do not edit here — edit the source note and re-export.${tail} -->`;
}


/** The acceptance lines for one compiled file: its own note, every note it
 *  transcludes (an embed the gate refused is in `sources` too, and says so),
 *  and every policy injected into it. Undefined when no map was supplied. */
function acceptanceLines(
  map: TransformOptions["acceptance"],
  refused: TransformOptions["refused"],
  own: string,
  transcluded: Iterable<string>,
  policies: Iterable<string>,
): string[] | undefined {
  if (!map) return undefined;
  const line = (path: string, role: string): string => {
    const rec = role === "transcluded" && refused?.has(path) ? undefined : map.get(path);
    const label = role ? `${soft(path)} (${role})` : soft(path);
    return rec
      ? `${label} — verified by ${soft(rec.by)}${rec.at ? ` at ${soft(rec.at)}` : ""}`
      : `${label} — NOT accepted; its text was not inlined`;
  };
  const out: string[] = [];
  if (own === SYNTH_ROOT_PATH) out.push("(synthesized root) — generated by the compiler; no source note");
  else out.push(line(own, ""));
  for (const p of [...new Set(policies)].sort()) out.push(line(p, "policy"));
  for (const p of [...new Set(transcluded)].sort()) out.push(line(p, "transcluded"));
  return out;
}

function fileBaseOf(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/, "");
}

export function transformAll(notes: NoteInput[], opts: TransformOptions): TransformResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const preloadCap = typeof opts.preloadCap === "number" && Number.isFinite(opts.preloadCap) && opts.preloadCap >= 0
    ? Math.trunc(opts.preloadCap)
    : DEFAULT_PRELOAD_CAP;
  const preloads: PreloadPlacement[] = [];

  // ---- phase 1: parse candidate nodes ----
  const nodes: Node[] = [];
  const policies: Policy[] = [];
  const commands: Command[] = [];
  for (const note of notes) {
    const fm = note.frontmatter || {};
    if (fm.type === "policy") {
      policies.push({
        path: note.path, parentPaths: note.parentPaths ?? [], body: note.body.trim(),
        title: fileBaseOf(note.path), hard: fm.severity === "hard", sources: note.sources,
      });
      continue;
    }
    if (fm.type === "command") {
      // Flat: commands take no part in the tree — no parent, no ownership. `name` (or the
      // filename) becomes the slash-command name; the body is the prompt template.
      const nameBase = slug(str(fm.name) || fileBaseOf(note.path));
      commands.push({
        path: note.path,
        nameBase,
        rawDesc: descFallback(fm, nameBase),
        extra: passthrough(fm, COMMAND_PASSTHROUGH_FIELDS, note.path, warnings),
        body: note.body.trim(),
        genName: "",
        sources: note.sources,
      });
      continue;
    }
    const kind: Kind | null = fm.type === "agent" ? "agent" : fm.type === "skill" ? "skill" : null;
    if (!kind) continue;
    const fileBase = fileBaseOf(note.path);
    const extra = kind === "skill" ? passthrough(fm, SKILL_PASSTHROUGH_FIELDS, note.path, warnings) : {};
    const nameBase = slug(str(fm.name) || fileBase);
    // `preload` is a SKILL directive and `no-skills` an AGENT one; the other way round is a
    // no-op, so say so rather than letting the field sit there looking effective.
    let preload = fm[PRELOAD_FIELD] === true;
    const noSkills = fm[NO_SKILLS_FIELD] === true;
    if (preload && kind !== "skill") warnings.push(`${note.path}: \`${PRELOAD_FIELD}\` applies to skills — ignored on a ${kind} note`);
    if (noSkills && kind !== "agent") warnings.push(`${note.path}: \`${NO_SKILLS_FIELD}\` applies to agents — ignored on a ${kind} note`);
    // The platform's one constraint on the preload set: "You can't preload skills that set
    // `disable-model-invocation: true`, since preloading draws from the same set of skills
    // Claude can invoke" — a listed one is skipped and logged. Drop it here instead, so the
    // compiled `skills:` says what will actually be loaded.
    if (preload && kind === "skill" && (extra["disable-model-invocation"] === true || extra["disable-model-invocation"] === "true")) {
      warnings.push(`${note.path}: \`${PRELOAD_FIELD}\` is ignored — a skill with \`disable-model-invocation: true\` can't be preloaded (the platform skips it); it stays invocable by you`);
      preload = false;
    }
    nodes.push({
      kind,
      path: note.path,
      isRoot: fm.root === true,
      parentPaths: note.parentPaths ?? [],
      nameBase,
      id: str(fm.id),
      label: str(fm.label) || str(fm.name) || fileBase,
      rawDesc: descFallback(fm, nameBase),
      version: str(fm.version),
      tools: toolsArray(fm.tools),
      model: str(fm.model),
      crosscutting: fm.crosscutting === true,
      slot: str(fm.slot),
      preload: preload && kind === "skill",
      noSkills: noSkills && kind === "agent",
      sources: note.sources,
      extra,
      body: note.body.trim(),
      parent: null, children: [], ownedSkills: [], extraParents: [], attached: [],
      level: -1, genName: "", valid: true,
    });
  }
  const byPath = new Map(nodes.map((n) => [n.path, n]));

  // ---- phase 2: root ----
  const declaredRoots = nodes.filter((n) => n.isRoot);
  for (const r of declaredRoots) {
    if (r.kind !== "agent") { r.valid = false; errors.push(`${r.path}: root must be an agent`); }
  }
  const validRoots = declaredRoots.filter((r) => r.valid);
  for (const extra of validRoots.slice(1)) { extra.valid = false; errors.push(`${extra.path}: multiple roots; ignoring this one`); }
  let root: Node | null = validRoots[0] ?? null;
  if (!root && opts.synthesizeRoot !== false) {
    root = {
      kind: "agent", path: SYNTH_ROOT_PATH, isRoot: true, parentPaths: [],
      nameBase: "vault", label: "Vault",
      rawDesc: "General vault agent — routes each request to the appropriate sub-agent.",
      extra: {},
      body: "You are the general agent for this vault. Understand each request and delegate to the appropriate sub-agent; coordinate across sub-agents yourself when a request spans several.",
      crosscutting: false, preload: false, noSkills: false,
      parent: null, children: [], ownedSkills: [], extraParents: [], attached: [],
      level: 0, genName: "", valid: true,
    };
    nodes.unshift(root);
    byPath.set(root.path, root);
  }
  if (root) root.level = 0;

  // ---- phase 3: resolve each node's parents (first = primary tree edge, rest = attachments) ----
  for (const n of nodes) {
    if (n === root) continue;
    // Dedup first, so "the same agent twice" can't become a self-attachment further down.
    const seenParent = new Set<string>();
    const parentPaths: string[] = [];
    for (const p of n.parentPaths) {
      if (seenParent.has(p)) { warnings.push(`${n.path}: parent ${p} listed twice — the duplicate is ignored`); continue; }
      seenParent.add(p);
      parentPaths.push(p);
    }
    const [primaryPath, ...extraPaths] = parentPaths;
    if (primaryPath === undefined) {
      if (!root) { n.valid = false; errors.push(`${n.path}: no parent and no root`); continue; }
      n.parent = root; continue;
    }
    if (primaryPath === n.path) { n.valid = false; errors.push(`${n.path}: names itself as a parent`); continue; }
    const parent = byPath.get(primaryPath);
    if (!parent) { n.valid = false; errors.push(`${n.path}: unresolved parent ${primaryPath}`); continue; }
    if (parent.kind !== "agent") { n.valid = false; errors.push(`${n.path}: parent is not an agent`); continue; }
    n.parent = parent;
    // Every named parent is validated the same way, primary or not: an extra parent that
    // doesn't resolve, or that isn't an agent, is an error — it is a broken authored edge
    // either way. What an extra parent does NOT do is move the note in the tree.
    for (const ep of extraPaths) {
      if (ep === n.path) { n.valid = false; errors.push(`${n.path}: names itself as a parent`); continue; }
      const extraParent = byPath.get(ep);
      if (!extraParent) { n.valid = false; errors.push(`${n.path}: unresolved parent ${ep}`); continue; }
      if (extraParent.kind !== "agent") { n.valid = false; errors.push(`${n.path}: parent ${ep} is not an agent`); continue; }
      n.extraParents.push(extraParent);
    }
  }

  // ---- phase 4: validate reachability / cycles / depth; compute level ----
  for (const n of nodes) {
    if (!n.valid || n === root) continue;
    const seen = new Set<string>([n.path]);
    let cur: Node | null = n.parent;
    let steps = 1;
    while (cur && !cur.isRoot) {
      if (seen.has(cur.path) || !cur.valid) { n.valid = false; break; }
      seen.add(cur.path);
      cur = cur.parent;
      steps++;
    }
    if (!n.valid) { errors.push(`${n.path}: broken parent chain (cycle or invalid ancestor)`); continue; }
    if (!cur) { n.valid = false; errors.push(`${n.path}: parent chain does not reach the root`); continue; }
    n.level = steps;
    if (n.kind === "agent" && n.level > 4) warnings.push(`${n.path}: agent at level ${n.level} exceeds the depth-5 nesting cap and won't be reachable by live delegation`);
  }

  // ---- phase 5: wire children + ownership from valid nodes ----
  for (const n of nodes) {
    if (!n.valid || n === root || !n.parent) continue;
    if (n.kind === "agent") { if (!n.crosscutting) n.parent.children.push(n); }
    else n.parent.ownedSkills.push(n);
    // Attachment edges are wired only between valid nodes: an extra parent that failed its
    // own validation (broken chain, duplicate root, …) emits nothing to attach to, so the
    // attachment is dropped with a warning rather than invalidating this note too.
    for (const ep of n.extraParents) {
      if (!ep.valid) { warnings.push(`${n.path}: attached parent ${ep.path} is invalid — attachment ignored`); continue; }
      ep.attached.push(n);
    }
    n.extraParents = n.extraParents.filter((ep) => ep.valid);
  }

  // ---- resolve policy notes: attach each to the agent whose subtree it governs ----
  // (no parent ⇒ root ⇒ applies to every agent; strict single parent, must be an agent).
  // Policies keep the STRICT single-parent rule deliberately: a policy's parent is a lineage
  // edge — it decides which agents the body is injected into — so a second parent would mean
  // a second injection site, not a recorded attachment. Only skills/agents relaxed.
  const policiesByNode = new Map<string, Policy[]>();
  for (const pol of policies) {
    let parent: Node | null;
    if (pol.parentPaths.length > 1) { errors.push(`${pol.path}: policy has multiple parents (strict single-parent)`); continue; }
    else if (pol.parentPaths.length === 0) parent = root;
    else parent = byPath.get(pol.parentPaths[0]) ?? null;
    if (!parent) { errors.push(`${pol.path}: policy has an unresolved or missing parent`); continue; }
    if (parent.kind !== "agent") { errors.push(`${pol.path}: policy parent is not an agent`); continue; }
    if (!parent.valid) { errors.push(`${pol.path}: policy parent is invalid`); continue; }
    const arr = policiesByNode.get(parent.path) ?? [];
    arr.push(pol);
    policiesByNode.set(parent.path, arr);
  }
  // Policies governing an agent = those attached to any ancestor-or-self, root-most first.
  const applicablePolicyObjs = (n: Node): Policy[] => {
    const chain: Node[] = [];
    for (let cur: Node | null = n; cur; cur = cur.parent) chain.unshift(cur);
    return chain.flatMap((node) => policiesByNode.get(node.path) ?? []);
  };
  // Placement record for the preview: policy path → agent genNames its body landed in.
  const policyAgents = new Map<string, Set<string>>();
  const placePolicy = (polPath: string, agent: string): void => {
    (policyAgents.get(polPath) ?? policyAgents.set(polPath, new Set()).get(polPath)!).add(agent);
  };

  // ---- phase 6: names (dedup) ----
  const used = new Set<string>();
  for (const n of nodes) {
    if (!n.valid) continue;
    const base = n.id ? `${n.id}-${n.nameBase}` : n.nameBase;
    n.genName = uniqueName(base, used).name;
  }
  // Commands share the /plugin:<name> namespace with skills, so dedup against the same set —
  // a command and a skill both named `foo` would otherwise both claim `/plugin:foo`.
  for (const c of commands) {
    if (!c.nameBase) { errors.push(`${c.path}: command has an empty name — set a \`name:\` or give the note a filename with alphanumerics`); continue; }
    const { name, collided } = uniqueName(c.nameBase, used);
    if (collided) warnings.push(`${c.path}: command name \`${c.nameBase}\` collides with an existing skill/agent/command — renamed to \`${name}\``);
    c.genName = name;
  }

  const breadcrumb = (n: Node): string => {
    const labels: string[] = [];
    let cur = n.parent;
    while (cur && !cur.isRoot) { labels.unshift(cur.label); cur = cur.parent; }
    return labels.join(" › ");
  };
  const describe = (n: Node): string => {
    const bc = breadcrumb(n);
    return bc ? `[${bc}] ${n.rawDesc}` : n.rawDesc;
  };

  const scopeOf = (n: Node): string =>
    n.isRoot ? "the whole vault" : (breadcrumb(n) ? `${breadcrumb(n)} › ${n.label}` : n.label);
  const crosscut = nodes.filter((n) => n.valid && n.kind === "agent" && n.crosscutting);

  // ---- phase 7: render ----
  const generated: Generated[] = [];
  for (const n of nodes) {
    if (!n.valid) continue;

    if (n.kind === "skill") {
      const fmOut = toYaml({ name: n.genName, description: describe(n), version: n.version, ...n.extra });
      generated.push({ kind: "skill", relOut: `skills/${n.genName}/SKILL.md`, from: n.path,
        name: n.genName, description: describe(n),
        ...(n.sources?.length ? { sources: n.sources } : {}),
        content: `${fmOut}\n\n${provenanceFor(n.path, acceptanceLines(opts.acceptance, opts.refused, n.path, n.sources ?? [], []))}\n\n${n.body}\n` });
      continue;
    }

    // agent — the skills ATTACHED to it: those whose primary parent is this agent, plus
    // those naming it as an extra parent. Attachment is organizational; it decides what this
    // agent is recorded as carrying, not what any agent may invoke (every compiled skill is
    // reachable through the Skill tool regardless).
    const attachedSkills = [...n.ownedSkills, ...n.attached.filter((a) => a.kind === "skill")];
    // PRELOAD is opt-in per skill (`preload: true`) — see the header note: `skills:` is
    // context provisioning, so preloading a whole scope spends the fresh window.
    const preloadSkills = attachedSkills.filter((s) => s.preload);
    let skillRefs = preloadSkills.map((s) => `${opts.pluginName}:${s.genName}`);
    const label = n.path === SYNTH_ROOT_PATH ? "(synthesized root)" : n.path;
    if (n.noSkills && skillRefs.length) {
      warnings.push(`${label}: \`${NO_SKILLS_FIELD}\` is set, so the ${skillRefs.length} skill(s) opted into preloading here are not listed — drop one of the two`);
      skillRefs = [];
    }
    const overCap = skillRefs.length > preloadCap;
    if (overCap) {
      warnings.push(`${label}: ${skillRefs.length} skills preloaded into \`${n.genName}\` exceeds the preload cap of ${preloadCap} — preloading fills the fresh context window delegation exists to provide; leave the ones this agent can find on demand un-opted-in`);
    }
    if (skillRefs.length) preloads.push({ agent: n.genName, path: label, skills: skillRefs, overCap });

    // guarantee structural tools from tree position (Agent to delegate, Skill to invoke
    // attached skills). Only matters when tools are explicitly listed; omitting tools
    // inherits everything. Under `no-skills` the Skill guarantee is off — adding a tool the
    // next line denies would be theatre.
    let tools = n.tools;
    if ((n.children.length || (crosscut.length && !n.crosscutting)) && tools && !tools.includes("Agent")) tools = [...tools, "Agent"];
    if (attachedSkills.length && !n.noSkills && tools && !tools.includes("Skill")) tools = [...tools, "Skill"];
    // The one boundary the platform actually offers (subagent docs: to stop a subagent
    // invoking skills, omit Skill from `tools` or deny it here). `disallowedTools` is applied
    // before `tools` resolves, so denying Skill leaves the agent's other tools alone —
    // unlike an allowlist, which would also drop everything it forgot to mention.
    const disallowedTools = n.noSkills ? ["Skill"] : undefined;
    if (n.noSkills && tools?.includes("Skill")) {
      warnings.push(`${label}: \`tools\` lists Skill while \`${NO_SKILLS_FIELD}\` is set — the deny wins; remove Skill from \`tools\``);
    }
    const fmOut = toYaml({ name: n.genName, description: describe(n), tools, disallowedTools, model: n.model, skills: skillRefs });

    const policyObjs = applicablePolicyObjs(n);
    for (const p of policyObjs) placePolicy(p.path, n.genName);
    // Every policy whose body lands in this file, for its acceptance block.
    const injectedPolicies = new Set(policyObjs.map((p) => p.path));
    // Everything transcluded into this compiled file: the agent note's own embeds plus
    // embeds inside the policy bodies injected below (extended with hard-inline policy
    // embeds in the crosscutting branch).
    const agentSources = new Set(n.sources ?? []);
    for (const p of policyObjs) for (const s of p.sources ?? []) agentSources.add(s);
    // "Assembled" = the compiled file contains marked blocks owned by other notes. Only
    // then does the marker explanation belong (and only then does the file's content
    // differ from the note body alone).
    const assembled = agentSources.size > 0 || policyObjs.length > 0 || (n.crosscutting && policiesByNode.size > 0);

    let bodyOut = n.body;
    if (opts.vaultPath) {
      bodyOut += `\n\n## Vault access\n\nYour skills and agents are authored in the Obsidian vault at \`${opts.vaultPath}\`. You can read and write notes there directly (Read/Grep/Glob and Write/Edit under that path), or use the \`vault-mcp\` tools if connected.`;
      if (assembled) {
        bodyOut += ` This definition is assembled from multiple notes — transcluded and policy blocks are marked with their source paths (\`${transclusionOpen("…")}\`, \`${policyMarker("…")}\`); to change one, edit that note and re-export, never the compiled file.`;
      }
    }
    // Each injected policy names its source note, so an agent reading its own compiled
    // definition knows which note owns the text (see the Vault access paragraph above).
    const policyBlocks = policyObjs.map((p) => `${policyMarker(p.path)}\n${p.body}`);
    if (policyBlocks.length) {
      bodyOut += `\n\n${policyBlocks.join("\n\n")}`;
    }
    // Two lists, honestly labelled: what is already in the context window, and what is
    // attached but has to be invoked. Under `no-skills` neither is offered.
    const onDemandRefs = n.noSkills ? [] : attachedSkills.filter((s) => !s.preload).map((s) => `${opts.pluginName}:${s.genName}`);
    if (skillRefs.length || onDemandRefs.length) {
      const parts: string[] = [];
      if (skillRefs.length) parts.push(`These scope skills are preloaded into your context — use them for work in this scope: ${skillRefs.map((s) => `\`${s}\``).join(", ")}.`);
      if (onDemandRefs.length) parts.push(`These scope skills are attached to you but not preloaded — invoke them with the Skill tool when a task calls for one: ${onDemandRefs.map((s) => `\`${s}\``).join(", ")}.`);
      bodyOut += `\n\n## Skills\n\n${parts.join("\n\n")}`;
    }
    if (n.children.length) {
      const items = n.children.map((c) => `- \`${opts.pluginName}:${c.genName}\` — ${c.label}`);
      const heading = n.isRoot
        ? "## Vault routing\n\nYou are the general vault agent. Identify which sub-agent a request belongs to and delegate to it via the Agent tool (nested subagents work up to 5 levels deep):"
        : "## Delegates to\n\nDelegate sub-scope work to the matching agent via the Agent tool:";
      bodyOut += `\n\n${heading}\n${items.join("\n")}`;
    }
    if (crosscut.length && !n.crosscutting) {
      const specialists = crosscut.map((c) => `- \`${opts.pluginName}:${c.genName}\`${c.slot ? ` (${c.slot})` : ""}`);
      bodyOut += `\n\n## Cross-cutting specialists\n\nFor single-craft work on a standard-zero slot of your scope (${scopeOf(n)}), prefer the matching specialist and tell it which scope to work on — their full descriptions are already visible to you. Delegate via the Agent tool:\n${specialists.join("\n")}`;
    }
    if (n.crosscutting) {
      // Scope-policy index: a crosscutting agent works inside other scopes' content, but
      // compile-time injection only carries its own lineage. Give it a generated map of
      // scope → binding policies (discovered paths — no layout convention assumed), and
      // inline `severity: hard` policies in full so ruin-risk rules have no read step.
      const own = new Set(applicablePolicyObjs(n).map((p) => p.path));
      const entries: string[] = [];
      const hardInline: { pol: Policy; scope: string }[] = [];
      for (const a of nodes) {
        if (!a.valid || a.kind !== "agent" || a.crosscutting || a.isRoot) continue;
        const pols = (policiesByNode.get(a.path) ?? []).filter((p) => !own.has(p.path));
        if (!pols.length) continue;
        const items = pols.map((p) => {
          if (p.hard) { hardInline.push({ pol: p, scope: scopeOf(a) }); return `${p.title} (hard — included in full below)`; }
          return `${p.title} (\`${p.path}\`)`;
        });
        entries.push(`- ${scopeOf(a)} (\`${opts.pluginName}:${a.genName}\`): ${items.join("; ")}`);
      }
      if (entries.length) {
        bodyOut += `\n\n## Scope policies\n\nScoped policies bind any agent working on that scope's content, including you — your dispatch brief names the scope. Before working in a scope listed below, read its policy notes (and those of the scopes above it in its breadcrumb):\n${entries.join("\n")}`;
        // Dedup is defensive: strict single-parent means a policy lands on exactly one
        // index line today; this guards a future relaxation to shared policies.
        const seen = new Set<string>();
        const blocks = hardInline
          .filter((h) => !seen.has(h.pol.path) && seen.add(h.pol.path))
          .map((h) => `${policyMarker(h.pol.path)}\n**Hard policy — binds when working in ${h.scope}:**\n\n${h.pol.body}`);
        for (const h of hardInline) {
          placePolicy(h.pol.path, n.genName);
          injectedPolicies.add(h.pol.path);
          for (const s of h.pol.sources ?? []) agentSources.add(s);
        }
        if (blocks.length) bodyOut += `\n\n${blocks.join("\n\n")}`;
      }
    }

    const src = n.path === SYNTH_ROOT_PATH ? "(synthesized root)" : n.path;
    generated.push({ kind: "agent", relOut: `agents/${n.genName}.md`, from: src,
      name: n.genName, description: describe(n),
      ...(agentSources.size ? { sources: [...agentSources] } : {}),
      content: `${fmOut}\n\n${provenanceFor(src, acceptanceLines(opts.acceptance, opts.refused, n.path, agentSources, injectedPolicies))}\n\n${bodyOut}\n` });
  }

  // ---- commands (flat): emit a Claude Code slash command per note ----
  for (const c of commands) {
    if (!c.genName) continue; // empty-name command errored above, nothing to emit
    // No name/breadcrumb in the frontmatter: the slash-command name is the filename, and a
    // command has no scope in the tree. Body is the prompt template ($ARGUMENTS, !bash, @file).
    const fmOut = toYaml({ description: c.rawDesc, ...c.extra });
    generated.push({ kind: "command", relOut: `commands/${c.genName}.md`, from: c.path,
      name: c.genName, description: c.rawDesc,
      ...(c.sources?.length ? { sources: c.sources } : {}),
      content: `${fmOut}\n\n${provenanceFor(c.path, acceptanceLines(opts.acceptance, opts.refused, c.path, c.sources ?? [], []))}\n\n${c.body}\n` });
  }

  // The optional fields are OMITTED when empty/false, so a single-parent, no-preload tree
  // reads exactly as it did before this shape grew.
  const tree: TreeNode[] = nodes.filter((n) => n.valid).map((n) => ({
    name: n.genName,
    kind: n.kind,
    parent: n.parent ? n.parent.genName : null,
    level: n.level,
    skills: n.ownedSkills.map((s) => s.genName),
    children: n.children.map((c) => c.genName),
    crosscutting: n.crosscutting,
    ...(n.extraParents.length ? { extraParents: n.extraParents.map((p) => p.genName) } : {}),
    ...(n.attached.length ? { attached: n.attached.map((a) => a.genName) } : {}),
    ...(n.preload ? { preload: true } : {}),
    ...(n.noSkills ? { noSkills: true } : {}),
  }));

  const attachments: Attachment[] = nodes
    .filter((n) => n.valid && n.extraParents.length)
    .map((n) => ({
      name: n.genName,
      kind: n.kind,
      path: n.path,
      primary: n.parent ? n.parent.genName : null,
      extra: n.extraParents.map((p) => p.genName),
      preload: n.preload,
    }));

  // Placements only for policies that resolved to a valid agent (errored ones never landed).
  const resolvedPolicies = new Set([...policiesByNode.values()].flat());
  const policyPlacements: PolicyPlacement[] = policies
    .filter((p) => resolvedPolicies.has(p))
    .map((p) => ({ path: p.path, title: p.title, hard: p.hard, agents: [...(policyAgents.get(p.path) ?? [])] }));

  return { generated, warnings, errors, tree, policies: policyPlacements, attachments, preloads, preloadCap };
}
