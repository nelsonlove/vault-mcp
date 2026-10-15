import esbuild from "esbuild";

const production = process.argv.includes("production");

// No build-time defines and no assets: the surface is two MCP tools, a settings
// tab and the Drift pane over the pure conformance kernel (src/kernel/). The
// kernel's process entry (src/kernel/main.ts) is NOT bundled: it is the
// standalone CLI, run with `node --import tsx`, and it is kept apart from
// cli.ts so this CJS bundle never meets an `import.meta`.
await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian", "electron", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "node:net", "node:fs", "node:os", "node:path",
  ],
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
});
