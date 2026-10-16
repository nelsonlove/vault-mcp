// host-shim.mjs — a stand-in for the Vault MCP host's external-tool
// registration, so this package's handler-level tests exercise the ENVELOPES an
// agent actually sees. (Not a `*.test.mjs` file — the test glob skips it.)
//
// Since S3c these five tools are no longer registered on an `McpServer` inside
// the host. They are PUBLISHED through `vault-mcp-api` as `SdkToolSpec[]`, and a
// published tool's handler returns plain data or throws: the host turns the
// first into `ok(data)` and the second into `fail(err)`, where `fail` renders a
// lowercase-snake `code` off the error as `Error [code]: message`. That is the
// contract `src/tools/*.ts` is now written against, so testing the raw handlers
// alone would leave the refusal shape — the thing the old `codedError` used to
// guarantee — unpinned.
//
// This shim reproduces exactly FOUR host behaviours and nothing else. The first
// three are the other satellites' shims' (e.g. `packages/triage/tests/host-shim.mjs`), verbatim in intent;
// the fourth is this package's alone.
//
//   1. THE PUBLISHED NAME, including THE EXACT-NAME TABLE. The ordinary rule is
//      `<sanitized owner id>_<bare name>` and this plugin's id is `governor`, so
//      a new tool would publish as `governor_<name>`. These five do not: the host
//      carries a closed table naming both the spelling AND the single owner id
//      allowed to publish it bare, so `governance_revisions` stays
//      `governance_revisions` rather than becoming
//      `governor_governance_revisions`. The table below is a SNAPSHOT of the
//      host's (`packages/host/src/mcp/external-tools.ts`), carried as DATA. The
//      pin that SHOULD fire when the host's table changes is the host's own test
//      over the live `GRANDFATHERED_TOOL_NAMES` / `publishedToolName`, never this
//      copy — and as of 2026-09-08 THAT TEST DOES NOT EXIST: the host's
//      `external-tools.test.mjs` covers F1 only through the ungrandfathered case
//      (owner `obsidian-read` + name `note`), and neither it nor
//      `packages/vault-mcp-api/tests/` names any of the five spellings. So this
//      snapshot is currently the ONLY place the five names are asserted, which
//      makes it a review aid doing a tripwire's job. Named here rather than
//      quietly relied on: the host owes the live pin.
//   2. THE ENVELOPE. `ok` / `fail`, including `fail`'s coded rendering and its
//      lowercase-snake gate (a Node error's UPPERCASE `.code` renders plain), so
//      a `GovernanceRefusal` is asserted as the agent-visible
//      `Error [code]: message` string rather than as a thrown object.
//   3. THE ANNOTATIONS the host derives from an UNTRUSTED `readOnly` claim.
//      `readOnlyHint: true` from a publisher is an assertion about code the host
//      cannot inspect, so it is believed only when the RAW plugin id is listed in
//      `trustedReadOnlyPlugins` (empty by default). Untrusted ⇒ registered as
//      MUTATING, which is why `governance_mandates`, `governance_revisions` and
//      `governance_pending_review` are blocked in read-only mode despite reading
//      nothing. `trusted: true` opts into believing the claim, for the tests that
//      pin the difference. The base presets are `@vault-mcp/core`'s
//      SHARED_ANNOTATIONS RO/RW, reproduced literally — note `destructiveHint`
//      defaults to FALSE on both, and only an explicit `destructive` on the spec
//      overrides it.
//   4. F1 — THE `obsidian_*` NAMESPACE REFUSAL, UNCONDITIONAL, WITH NO BYPASS.
//
// ── WHY POINT 4 SAYS "NO BYPASS", AND WHY THAT SENTENCE MATTERS ─────────────
//
// The first draft of this shim reproduced an F1 CARVE-OUT, because the first
// draft of the host's table held `obsidian_pending_review` and let that one name
// through the reserved namespace. **Nelson ruled against it on 2026-09-08 and
// the tool was RENAMED to `governance_pending_review` instead.** The reasoning
// binds anything that comes here next: an F1 exception, even one gated on a
// provider id, permanently weakens a namespace-integrity rule and becomes the
// precedent for the next exception; the locked decision forbids renames "for
// zero semantic gain" and this rename HAS gain, because the `obsidian_` prefix
// branded a governance tool as a host built-in, which after the split is an
// architectural lie; and the breakage is near zero, since MCP tools are
// discovered per session.
//
// So the table below and F1 are TWO SEPARATE RULES and this shim keeps them
// separate: the table carves out the OWNER-PREFIXING rule only, and F1 refuses a
// published `obsidian_*` name whoever asks, including a name the table lists.
// There is deliberately no dormant exception branch to reactivate. A test plants
// a violation against each half, because a carve-out assertion that would pass
// under a shim that never refuses anything asserts nothing.
//
// This shim deliberately does NOT reproduce the F3 pathless-tool block, the path
// allowlist, the write queue, the write journal, read-only mode, the kernel
// arguments, or the record-immutability guard. Those are host code with host
// tests, and a second copy could drift into asserting a posture the host does
// not enforce. What this package DOES pin about them is the only half it owns —
// which of its arguments the host would recognize as a path (see
// `publication.test.mjs`).

/** This plugin's own id — unchanged by the split, because the authority state did not move. */
const PLUGIN_ID = "governor";

/** The host's `sanitizeOwnerId`, verbatim. */
export function sanitizeOwnerId(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const OWNER = sanitizeOwnerId(PLUGIN_ID);

/**
 * A SNAPSHOT of the host's `GRANDFATHERED_TOOL_NAMES` — bare name → the one
 * owner id allowed to publish it unprefixed. Carried as data for the reason
 * stated in the header.
 *
 * Four of the five are here for CONTINUITY (they were on the wire when the split
 * happened). `governance_pending_review` is here for FAMILY CONSISTENCY: it is
 * the rename, and four bare names beside one `governor_governance_pending_review`
 * would recreate, in the tool list an agent reads, exactly the incoherence the
 * rename removed.
 *
 * IT IS CLOSED on the host's side and must stay closed here. A sixth entry in
 * this file would assert a carve-out the host does not grant, which is exactly
 * the drift a shim is supposed to make visible rather than hide. NO ENTRY MAY
 * BEGIN `obsidian_` — F1 is asked of grandfathered names too, so such an entry
 * would be unpublishable rather than privileged.
 */
export const HOST_GRANDFATHERED_TOOL_NAMES = new Map([
  ["governance_pending_review", "governor"],
  ["governance_revisions", "governor"],
  ["governance_submit_revision", "governor"],
  ["governance_mandate_draft", "governor"],
  ["governance_mandates", "governor"],
]);

/**
 * The host's `PATH_KEYS` + `ARRAY_PATH_KEYS` (`packages/host/src/guard.ts`),
 * copied as DATA so this package can assert which of its own argument names the
 * host would recognize. The host owns the enforcement; this is only the list the
 * assertion reads against, spelled out so a host addition (or removal) shows up
 * as a diff in review rather than silently changing this package's posture. The
 * pin that actually fires when the host changes the list is its own
 * `guard.test.mjs` over the live `collectPaths`.
 *
 * `note_path` joined the host's list on 2026-09-07 (the mutating tier's round
 * one). No tool in THIS package names it — `governance_submit_revision` has
 * always spelled its argument `path` — so this package's posture is unchanged by
 * that addition.
 */
export const HOST_PATH_KEYS = [
  "path", "from", "to", "target_path", "template_path", "subdir", "file_path", "output_folder", "note_path",
  "paths", "refs",
];

/** The host's `publishedToolName` (`external-tools.ts`), verbatim over the snapshot. */
export function publishedToolName(ownerPluginId, bareName) {
  if (HOST_GRANDFATHERED_TOOL_NAMES.get(bareName) === ownerPluginId) return bareName;
  return `${sanitizeOwnerId(ownerPluginId)}_${bareName}`;
}

/** The host's `ok()` (from `@vault-mcp/core` via `mcp/helpers.ts`). */
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/** The host's `fail()`, including the coded branch and its lowercase-snake gate. */
function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code)) {
    return { content: [{ type: "text", text: `Error [${code}]: ${message}` }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** `@vault-mcp/core`'s SHARED_ANNOTATIONS.RO / .RW, reproduced literally. */
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/**
 * Publish SDK tool specs the way the host does.
 *
 * `owner` defaults to this plugin's id; a test passes another to prove the
 * exact-name carve-out is gated on the owner as well as on the name.
 *
 * Returns `{ tools }`, a Map from the PUBLISHED name to
 * `{ def, spec, bare, handler }` — the same shape the host's own `fakeServer`
 * produces, so assertions read the same on both sides of the split. `bare` is
 * true when the table let the name through unprefixed; `def.claimsReadOnly`
 * records the publisher's raw assertion beside the host's conclusion, because
 * the gap between them IS this package's allowlist posture.
 *
 * Throws on an F1 collision, unconditionally, exactly as
 * `ExternalToolRegistry.registerTools` does.
 */
export function publishInto(specs, { trusted = false, owner = PLUGIN_ID } = {}) {
  const tools = new Map();
  for (const spec of specs) {
    const toolName = publishedToolName(owner, spec.name);
    // F1, asked of EVERY name including a listed one — see the header. There is
    // no `grandfathered &&` guard here and there must never be one again.
    if (toolName.startsWith("obsidian_")) {
      throw new TypeError(`vault-mcp: tool name '${toolName}' collides with the reserved obsidian_* namespace`);
    }
    const claimsReadOnly = spec.readOnly === true;
    const isReadOnly = claimsReadOnly && trusted;
    const annotations = { ...(isReadOnly ? RO : RW) };
    // The SDK only forwards these two when the spec sets them; the host only
    // overlays them when forwarded. Two conditionals, one observable rule.
    if (spec.destructive !== undefined) annotations.destructiveHint = spec.destructive;
    if (spec.idempotent !== undefined) annotations.idempotentHint = spec.idempotent;
    const def = { title: toolName, description: spec.description, inputSchema: spec.inputSchema, annotations, claimsReadOnly };
    tools.set(toolName, {
      def,
      spec,
      bare: toolName === spec.name,
      handler: async (args) => {
        try {
          // F5: the host normalizes a handler's return value to a plain object
          // so `ok()` emits valid structuredContent.
          const r = await spec.handler(args ?? {});
          const data =
            r === undefined ? { ok: true } : typeof r === "object" && r !== null && !Array.isArray(r) ? r : { result: r };
          return ok(data);
        } catch (e) {
          return fail(e);
        }
      },
    });
  }
  return { tools };
}
