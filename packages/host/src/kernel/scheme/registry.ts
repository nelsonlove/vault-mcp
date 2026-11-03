// Moved to @vault-mcp/core (scheme/registry.ts) on 2026-10-14 so the conformance and scheme satellites
// share one copy; re-exported here so no importer in the host moved.
export { DEFAULT_SCHEMES, JD_SCHEME_INSTANCE, schemesOnLoad, SchemeRegistry, validateExcludedRoots, excludeRoots, makeRegistry, SchemeUnavailableError, SchemeRefRetiredError, refuseSchemeRefs } from "@vault-mcp/core";
export type { SchemesOnLoad, SchemeInstanceConfig, SchemeInstance, ParsedRef } from "@vault-mcp/core";
