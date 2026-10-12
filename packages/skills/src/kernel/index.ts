// src/kernel — the pure skills-export core of the vaultmcp-skills satellite.
//
// Lineage: written for the standalone obsidian-vault-skills plugin, folded into
// the Vault MCP host as `src/kernel/skills/` (#82, cycle 2), and extracted back
// out to its own plugin at the suite split's S4. The code is the same code; the
// three homes differ only in who mounts it.
//
// Every file here is Obsidian-free: the exporter/transform/transclude compiler
// runs over an injected `SkillsSource` (skills-source.ts). The Obsidian-facing
// adapter and the six tool specs live in ../tools.ts; the pane, commands and
// export-on-save wiring in ../wiring.ts. Nothing here imports `obsidian` or the
// MCP SDK, which is why the whole compiler is unit-tested headlessly.

export type { SkillsSource, SourceNote, EmbedLookup } from "./skills-source.js";
export {
  analyzeVault,
  previewVault,
  runExport,
  readPluginVersion,
  markFrontmatter,
  applyMark,
  excludedSummary,
  excludedWarning,
  acceptedEmbed,
  embedAcceptance,
  agentCandidates,
  detectKind,
  fieldView,
  DEFAULT_FIELDS,
  DEFAULT_TAG_PREFIX,
  EXPORTABLE_TYPES,
  IDENTITY_TYPE_MAP,
  mappedKind,
  spellingFor,
  inRoots,
  compiles,
  guardedReach,
  type GuardedReach,
  type Analysis,
  type PreviewResult,
  type PreviewEntry,
  type ExportSummary,
  type ExportOptions,
  type MarkInput,
  type MarkResult,
  type FieldConfig,
  type DetectConfig,
} from "./exporter.js";
export {
  DEFAULT_PRELOAD_CAP,
  NO_SKILLS_FIELD,
  PRELOAD_FIELD,
  type Attachment,
  type PreloadPlacement,
  type TreeNode,
} from "./transform.js";
export {
  DEFAULT_SKILLS_CONFIG,
  skillsConfigOf,
  typeMapOf,
  parseTypeMapLines,
  typeMapLines,
  fieldsOf,
  validateSkillsConfig,
  expandTilde,
  type SkillsConfig,
} from "./skills-config.js";

export type { ExcludedNote, Excluded } from "./exporter.js";
