#!/usr/bin/env node
// main.ts — the process entry for the headless conformance rail.
//
// Kept SEPARATE from cli.ts so the importable core (cli.ts) carries no
// `import.meta`. The vaultmcp-conformance plugin imports `runConformance` from
// cli.ts for its debt tools and Drift pane, and esbuild cannot represent
// `import.meta` in the plugin's CJS bundle (it warns and shims it). Isolating
// the process-entry guard here keeps cli.ts bundle-clean while preserving direct
// invocation, from packages/conformance:
// `node --import tsx src/kernel/main.ts --root=<path> …` (or `npm run conformance -- --root=<path> …`).

import { runCli } from "./cli.js";

runCli(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`conformance: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 3;
});
