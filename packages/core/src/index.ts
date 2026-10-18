export { ok, fail } from "./responses.js";

// ── Accept-forbidden guard (issue #104) ─────────────────────────────────────
// packages/core's own copy of the predicate + the canonical leading-frontmatter
// recognizer (stripLeadingBom / LEADING_FRONTMATTER_RE, matching PR #129's
// definition in the plugin — core cannot import from plugin, so this is a
// parallel, not a shared, definition; unifying the two is a follow-up once
// #129 has landed and settled). Every fs-backend write primitive
// (fs-backend/vault.ts's VaultImpl, which both FilesystemBackend and
// packages/server's fs-failover singleton functions call) routes through this
// one implementation.
export {
  AcceptForbiddenError,
  acceptTransitionReason,
  acceptForbiddenReason,
  frontmatterOf,
  leadingFrontmatterBlock,
  stripLeadingFrontmatter,
  parseGuardFrontmatter,
  stripLeadingBom,
  LEADING_FRONTMATTER_RE,
  // Declared protected properties (#224) — the generalized perimeter.
  DEFAULT_PROTECTED_PROPERTIES,
  normalizeProtectedProperties,
  setDeclaredProtectedProperties,
  declaredProtectedProperties,
  declaredGradeOf,
  canonicalPropertyKey,
  isAuthorityFamilyKey,
  findPropertiesCanonical,
  frontmatterValuesEqual,
  acceptTransitionNeedsBefore,
  isVerifiedKey,
  isBlankVerification,
  isHumanVerification,
  hasHumanVerification, humanVerificationOf,
  unverifiableProtectedPropertyIn,
  unverifiableBeforeReason,
  parseProtectedPropertyLines,
  formatProtectedPropertyLines,
} from "./accept-guard.js";
export type { ProtectedProperty, ProtectedPropertyGrade } from "./accept-guard.js";
export {
  TRUNCATION_TRAILER_RE,
  truncationTrailer,
  truncateForRead,
  isCutRead,
  carriesTruncationTrailer,
  TruncatedReadError,
  assertNotTruncatedRead,
  wholeNoteOverwriteRefusal,
  assertPatchRangeRead,
  noteLengthFrom,
  cutReadError,
} from "./truncation.js";
export { WholeReads, WRITE_WINDOW_MS, wholeReadToken } from "./whole-reads.js";
export type { RevToken } from "./whole-reads.js";
export { SYNC_UNSAFE_CHARS, UnsafeNameError, syncUnsafeChars, assertSyncSafeName, assertSyncSafeMove, inJdArchive, jdArchiveFolder, hasInboundLinks, type BracketContext, type ArchiveMatcher } from "./sync-names.js";
export {
  SHARED_ANNOTATIONS,
  FS_TOOLS,
  PROP_RE,
  FmValue,
} from "./tool-registry.js";
export type { Capability, ToolDef, ToolAnnotations } from "./tool-registry.js";
export { registerFsTools } from "./register-fs-tools.js";
export { strictInput, isObjectSchema, inputShapeOf, inputObjectOf, extendInput } from "./strict-input.js";
export type { InputShape, InputSchema } from "./strict-input.js";
export { renderNoteWithFrontmatter, opensWithFrontmatter, jsonFlowYaml } from "./note-frontmatter.js";
export type { RegisterFsToolsOpts, IndexStatusSnapshot } from "./register-fs-tools.js";
export type {
  VaultBackend,
  FrontmatterScalar,
  FrontmatterEditValue,
  FrontmatterValue,
  NoteRef,
  SearchHit,
  SearchMode,
  ReadNoteResult,
  ReadNoteError,
  ReadNotesResult,
  PatchAnchor,
  PatchOp,
  ResolveResult,
  OutlinkEntry,
  FrontmatterSearchResult,
  ManageFrontmatterResult,
} from "./vault-backend.js";

// ── Filesystem backend ──────────────────────────────────────────────────────

export { FilesystemBackend } from "./fs-backend/filesystem-backend.js";

// Vault filesystem functions (module-level, bound to process.env.VAULT_PATH)
export {
  CHARACTER_LIMIT,
  InvalidPathError,
  decodeHtmlEntities,
  vaultRoot,
  resolveInVault,
  listNotes,
  readNote,
  readNoteWhole,
  writeNote,
  appendNote,
  searchNotes,
  listFolders,
  findByTag,
  setFrontmatterField,
  deleteFrontmatterField,
  getFrontmatterField,
  patchNote,
  deleteNote,
  moveNote,
  createVaultAt,
} from "./fs-backend/vault.js";
export type { VaultImpl } from "./fs-backend/vault.js";

// Index store functions (module-level singleton) and per-instance class
export {
  buildIndex,
  indexStatus,
  resolveRefs,
  getBacklinks,
  getOutlinks,
  searchByFrontmatter,
  getIndexedFrontmatter,
  applyAddOrChange,
  applyUnlink,
  parseAllFrontmatter,
  parseOutlinks,
  deriveJdIdFromPath,
  IndexStore,
} from "./fs-backend/index-store.js";
export type { IndexStatus, IndexedNote } from "./fs-backend/index-store.js";

// Vault watcher
export { startVaultWatcher } from "./fs-backend/vault-watcher.js";
export type { VaultWatcherOptions, VaultWatcherHandle } from "./fs-backend/vault-watcher.js";

// Sessions — the CONTRACT only (suite split, S3, condition 7: "the HOST keeps
// minting ... SessionV1 therefore becomes a published contract"). The mint
// itself (`openSession`) stays host-side, because minting is a host
// responsibility, not because of where a dependency happens to live.
export {
  SESSION_TTL_MS,
  NO_DIRECT_WRITES,
  SessionNotLiveError,
  isLive,
  livenessOf,
  expiryRefusal,
  attachMandate,
  closeSession,
  revokeSession,
  expireSession,
} from "./session.js";
export type { SessionId, SessionStatus, SessionV1 } from "./session.js";

// Dispositions — the GENERIC descriptor substrate only (suite split, S3,
// condition 9). Triage's own descriptors stay host-side (triage is a future
// satellite, and the provider must not depend on a satellite); the provider's
// acceptance-specific unions and verb table stay with the provider.
export {
  dispositionsForSurface,
  dispositionByIdIn,
  gestureGatedIn,
} from "./dispositions.js";
export type { DispositionAuthority, DispositionDescriptorShape } from "./dispositions.js";

// Canonical JSON + digests — published as contracts at the suite split's S3
// (condition 9). The host needs them for its OWN session scope digest, which
// is a host assertion about a connection, so they cannot stay provider-internal.
export { canonicalize, NoncanonicalValueError } from "./canonical-json.js";
export type { CanonicalValue } from "./canonical-json.js";
export { digestBytes, digestUtf8, isSha256Digest } from "./digest.js";
export type { Sha256Digest } from "./digest.js";

// Id generation — shared, not host-private: the provider mints ids too
// (gesture.ts, contracts/ids.ts), and forking the mint would give one vault
// two id formats.
export { uuidv7 } from "./uuidv7.js";

// Guarded territories — vault areas neither half of the suite may review,
// capture, or retain copies of. PUBLISHED rather than held as host config
// (suite split, S3, condition 9's ruling): its importers land on both sides of
// the split, and the alternative — two copies — is the failure its own header
// names, where a prefix missing from capture's list means capture writes note
// bodies to disk. The list became configuration at #321/#396, and #397 settled its owner: the HOST plugin holds the setting and publishes it, and the governance provider reads it — see `resolveTerritories` for the blank-means-EMPTY rule both sides share (no default, ruled 2026-09-22).
export { LEGACY_TERRITORY_SEED, isExcludedTerritory, matchesTerritoryPrefix, resolveTerritories } from "./territories.js";

// Path-allowlist visibility — the one-path disclosure predicate, published at
// the skills satellite extraction (suite split, S4). A satellite that filters
// what it discloses must ask the SAME question the host asks; a forked copy of
// a guard predicate is the drift this repo has already paid for twice. The
// host's guard.ts keeps everything that knows the tool surface's argument
// shapes (mapPaths / collectPaths / guardCall / visiblePaths) and defines its
// allowlist branch over this function.
export { isVisible } from "./visibility.js";
export type { GuardSettings } from "./visibility.js";

// `resolveScope` — the validator for a bare `scope` STRING argument, published
// at the read-tier satellite extraction (suite split, S7) for the same reason
// as `isVisible`, and with the same alternative declined. A `scope` is not in
// the host's PATH_KEYS, so the guard never sees it and every tool taking one
// must check it by hand; `obsidian_lint` did not until 2026-08-29, which was a
// live read-boundary bypass. When that tool left for the `vaultmcp-health`
// satellite the choice was publish or fork, and forking a guard predicate is
// the drift this repo has paid for three times. Its two callers are now in
// different plugins: the host's `obsidian_check_links` and the health
// satellite's lint. `normalizePosix` rides along because the host's
// `tools-scheme.ts` needs the identical normalizer for its own scope handling
// and core is where the one copy now lives.
export { resolveScope } from "./scope.js";
export type { ScopeRefusal } from "./scope.js";
export { normalizePosix } from "./visibility.js";
// Write scope — what a session may write, separate from the read allowlist (write-scope.ts).
export {
  DEFAULT_WRITE_SCOPE,
  normalizeWriteScope,
  globToRegExp,
  inWriteScope,
  writeScopeRefusal,
  writeScopeRefusalForPath,
  CREATE_TOOLS,
  COMPUTED_CREATE_TOOLS,
} from "./write-scope.js";
export type { WriteScope, WriteScopeMode } from "./write-scope.js";
// Connection profiles — which tools one (remote) connection may see and call (profile.ts, #521).
export { READ_PROFILE_TOOLS, READ_MESSAGE_PROFILE_TOOLS, MESSAGE_TOOL, INBOX_WRITE_SCOPE, PROFILE_NAMES, isProfileName, resolveProfile, profileAllows, profileCallRefusal } from "./profile.js";
export type { ConnProfile, ProfileName } from "./profile.js";

// ── The controlled-vocabulary kernel (suite split, S7) ──────────────────────
//
// Published INTO core rather than moved into the `vaultmcp-vocab` satellite,
// because it has TWO consumers and always did: the four vocabulary tools (now
// the satellite's) and the conformance rail (the HOST's at S7, its own
// `vaultmcp-conformance` satellite since 2026-10-14) — `kernel/packs/vocab.ts`
// wraps `noteVocabFindings`, `kernel/cli.ts` builds a `VocabRegistry` per
// run, `kernel/snapshot.ts` and `rule-pack.ts` are typed over `VocabNote`,
// and `obsidian-drift-source.ts` / `obsidian-debt-source.ts` fall back to
// `DEFAULT_VOCABULARIES`. This is exactly the shape of the `queryBaseRows`
// question the triage extraction answered by leaving the seam behind, and it
// has the same forbidden answer: two copies of a rule core is how one vault
// gets two vocabularies. Conformance became a satellite too (2026-10-14), so
// core is where both consumers meet, as planned (suite-split-design.md §6).
//
// It qualifies on the same grounds `isVisible` did: pure, Obsidian-free, no MCP
// SDK, no host types — it already imported `leadingFrontmatterBlock` from here
// before the move.
export { VocabAmbiguousError, asStrings } from "./vocab/provider.js";
export type {
  VocabCapabilities,
  VocabEntry,
  VocabFinding,
  VocabKind,
  VocabularyProvider,
} from "./vocab/provider.js";
export { blueprintProvider, scanFrontmatter } from "./vocab/blueprint.js";
export type { BlueprintConfig, VocabNote } from "./vocab/blueprint.js";
export { glossaryProvider, parseTermsSection, resolveGlossaryConfig, DEFAULT_GLOSSARY_CONFIG } from "./vocab/glossary.js";
export type { GlossaryConfig } from "./vocab/glossary.js";
export { noteVocabFindings, vocabularyFindings } from "./vocab/findings.js";
export type { NoteVocabInput } from "./vocab/findings.js";
export {
  scopeTagsProvider,
  scopeTagsFindings,
  validateScopeTagsConfig,
  resolveScopeTagsConfig,
  parseTagsTable,
  isScopeTagsSource,
  DEFAULT_SCOPE_TAGS_CONFIG,
} from "./vocab/scope-tags.js";
export type { ScopeTagsConfig, ScopeTagsProvider } from "./vocab/scope-tags.js";
export { VocabRegistry, DEFAULT_VOCABULARIES, VOCAB_PROVIDERS, isVocabProvider } from "./vocab/registry.js";
export type { VocabInstance, VocabInstanceSettings, VocabProviderName } from "./vocab/registry.js";

// The QuickAdd executeChoice seam, published at the triage satellite extraction
// (suite split, S5) for the same reason as `isVisible`. Its own header already
// said it exists so the two surfaces that drive a choice headlessly "cannot
// drift on how a choice is resolved and invoked" — and after S5 those two
// surfaces are in DIFFERENT PLUGINS: the host's `obsidian_run_command` (the
// agent-named path, gated by the cli-policy opaque-execution deny) and the
// triage satellite's declared `choice` dispositions (the human-bound path,
// where the config binding IS the human re-enable). Copying it into the
// satellite would have made the drift the file was written to prevent. It
// contains NO policy decision and takes `app` duck-typed, so it carries no
// `obsidian` import and belongs here cleanly.
export { executeQuickAddChoice } from "./quickadd-choice.js";
export type { ChoiceOutcome } from "./quickadd-choice.js";

// ── The subprocess primitives, published at the mutating tier's extraction ───
//
// `spawnEnv` / `findBinary` were the host's `src/claude-cli.ts`; `findObsidianBinary`
// was `src/mcp/tools-cli.ts`. The `vaultmcp-fileclass` satellite spawns the
// `fileclass` CLI and needs all three to behave EXACTLY as the host's do — the
// same PATH augmentation, the same obsidian-binary probe — so they were
// published rather than forked, on the `isVisible` / `executeQuickAddChoice` /
// `resolveScope` precedent. The host imports them from here and re-exports
// them, so no host call site moved.
export { spawnEnv, findBinary, findObsidianBinary, EXTRA_BIN_DIRS } from "./spawn.js";

// ── The accept-fence scan, published at the mutating tier's extraction ───────
//
// `scanForAcceptFence` came verbatim out of the host's `mcp/tools-cli.ts`. Its
// two callers now live in different plugins — the host's `obsidian_cli`
// template/content guard and the `vaultmcp-jd-scaffold` satellite's template
// apply — which is the vocabulary kernel's shape at S7 and has the same
// forbidden answer: two copies of an accept predicate is how one vault gets two
// definitions of "accepted". Behaviour-preserving by construction: every symbol
// it is defined over was already core's, reached by the host through
// `mcp/write-notes-compose.ts`, itself a bare re-export of this accept-guard.
export { scanForAcceptFence } from "./accept-scan.js";

// ── The settings split, published at the host/provider split (S3c) ───────────
//
// Which of the pre-split plugin's `data.json` keys belong to the host and which
// to the governance provider. Both plugins read the SAME file — the provider
// keeps the folder and the file, the host copies its half out once — so the two
// halves have to agree about the whole shape. Declared twice, they would not:
// a key both claim gets each plugin's save overwriting the other's edit, and a
// key neither claims is dropped on the first save after the split. Same
// one-table reasoning as `isVisible` and `scanForAcceptFence`.
export { splitSettings, HOST_SETTING_KEYS, PROVIDER_SETTING_KEYS, PROVIDER_MODULE_IDS } from "./settings-split.js";
export type { HostSettingKey, ProviderSettingKey } from "./settings-split.js";

// ── Action-contract vocabulary and the vault slug, published at S3c ──────────
//
// The action REGISTRY stays the host's (§6). What crosses is the small part the
// governance provider's write observer must agree with byte-for-byte: the
// canonical change-class order (two producers hashing the same subject must
// sort classes the same way) and the `note.write` identity the observer speaks
// for. `vaultSlug` is published for the same class of reason and at its
// sharpest: the host names the socket by it and the provider names the standing
// chain's git directory by it, and a one-character disagreement reads as "chain
// absent here" on the machine that is holding the chain.
export { CHANGE_CLASSES, NOTE_WRITE_ACTION } from "./action-contract.js";
export type { ChangeClass } from "./action-contract.js";
export { vaultSlug } from "./vault-slug.js";

// ── Shared with the conformance and scheme satellites (2026-10-14) ─────────────
// The JD scheme grammar and registry (jd: addressing stays in the host's guard),
// scheme findings, the argument-path walk, path identity and the env aliases:
// published into core, as the vocab kernel was, so a satellite and the host read
// one copy (suite split; Nelson, 2026-10-14: "the conformance and scheme features
// still in core ... need to be split out into satellites").
export type { Capabilities, Address, Scope, Member, SchemeFinding, ScopeProvider } from "./scheme/provider.js";
export { DEFAULT_JD_CONFIG, jdProvider, validateJdConfig } from "./scheme/jd.js";
export type { JdConfig } from "./scheme/jd.js";
export { DEFAULT_SCHEMES, SchemeRegistry, validateExcludedRoots, excludeRoots, makeRegistry, AddressUnresolvedError, AddressAmbiguousError, SchemeUnavailableError, requireOneAddress, resolveSchemeArgs } from "./scheme/registry.js";
export type { SchemeInstanceConfig, SchemeInstance, ParsedRef, SchemeAddressing } from "./scheme/registry.js";
export { schemeFindings } from "./scheme/findings.js";
export { intendedRealPath, sameFile, isInside } from "./path-identity.js";
export { envAliased, envAliasNames } from "./env-alias.js";
export { mapPaths, collectPaths, visiblePaths } from "./guard-paths.js";
