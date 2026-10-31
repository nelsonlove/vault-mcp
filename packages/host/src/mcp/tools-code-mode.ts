// Code Mode — the compact meta-tool surface. Instead of registering ~40+ tool
// schemas into every session's context, a --code-mode connection gets exactly
// three tools over the same registry:
//
//   obsidian_search_tools  — find tools by keyword (progressive discovery)
//   obsidian_describe_tool — full input JSON Schema for one tool
//   obsidian_call_tool     — invoke any tool by name with validated args
//
// buildMcpServer captures every registerTool call (built-in, integration, CLI,
// external) into a CapturedRegistry with the guard wrapper already applied, so
// read-only mode and the path allowlist bind exactly as they do on the full
// surface — the guard sees the TARGET tool's annotations and args, not the
// meta-tool's. Args are validated against the captured zod schema before the
// handler runs, matching the SDK's own validation on the full surface.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SHARED_ANNOTATIONS, inputObjectOf, type InputSchema } from "@vault-mcp/core";
import { ok, fail } from "./helpers.js";

export interface CapturedTool {
  def: {
    title?: string;
    description?: string;
    inputSchema?: InputSchema;
    annotations?: { readOnlyHint?: boolean; [k: string]: unknown };
  };
  /** The guard-wrapped handler — invoking it enforces read-only/allowlist.
   * Typed `any` because captured handlers already produce SDK CallToolResult
   * shapes (they were written against registerTool); re-deriving that union
   * here would duplicate the SDK type for no safety gain. */
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<any>;
}

export type CapturedRegistry = Map<string, CapturedTool>;

/**
 * The code-mode replacement for server.registerTool: capture the (guarded)
 * tool into the registry instead of registering it on the SDK server. Pure so
 * the capture semantics — including the SDK-mirroring duplicate-name throw —
 * are unit-testable without an McpServer.
 */
export function makeCaptureRegister(
  registry: CapturedRegistry,
  wrap: (def: any, handler: any, name: string) => CapturedTool["handler"]
) {
  return (name: string, def: any, handler: any) => {
    // Mirror the SDK's duplicate-name throw: silent Map replacement would let
    // a later registrant shadow an earlier one with no error, diverging from
    // the full surface (where external-tools.ts relies on the throw to
    // skip-and-log a colliding entry).
    if (registry.has(name)) throw new Error(`Tool ${name} is already registered`);
    // The tool name travels into the wrap: the journal records the operation by
    // name, and in code mode this is the only place it is still in hand.
    registry.set(name, { def, handler: wrap(def, handler, name) });
    // Callers ignore the RegisteredTool return value; a stub keeps the shape.
    return { name };
  };
}

const RO = SHARED_ANNOTATIONS.RO;

function summarize(name: string, t: CapturedTool) {
  return {
    name,
    title: t.def.title ?? name,
    description: t.def.description ?? "",
    mutating: t.def.annotations?.readOnlyHint === false,
  };
}

export function searchRegistry(registry: CapturedRegistry, query?: string) {
  // Whitespace-tokenized AND match, with underscores in tool names treated as
  // word separators — so the natural query "read note" finds
  // obsidian_read_note instead of returning zero hits (whole-query substring
  // matching fails every multi-word query an agent is likely to type).
  const tokens = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: ReturnType<typeof summarize>[] = [];
  for (const [name, t] of registry) {
    if (tokens.length) {
      const hay = `${name} ${name.replace(/_/g, " ")}\n${t.def.title ?? ""}\n${t.def.description ?? ""}`.toLowerCase();
      if (!tokens.every((tok) => hay.includes(tok))) continue;
    }
    out.push(summarize(name, t));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function describeTool(registry: CapturedRegistry, name: string) {
  const t = registry.get(name);
  if (!t) return null;
  return {
    ...summarize(name, t),
    annotations: t.def.annotations ?? {},
    input_schema: zodToJsonSchema(inputObjectOf(t.def.inputSchema)),
  };
}

/**
 * Invoke a captured tool by name: validate the args against the captured zod
 * shape, then run the GUARDED handler (the guard/queue/journal wrapper travels
 * with the captured handler — see makeCaptureRegister). This is the single
 * invocation path over a captured registry: `obsidian_call_tool` delegates
 * here, and the in-Obsidian dev tool-runner (src/tool-runner.ts) calls it
 * directly — so a runner call takes byte-for-byte the same route an MCP
 * code-mode call takes, guard included.
 */
export async function callCapturedTool(
  registry: CapturedRegistry,
  name: string,
  args: Record<string, unknown> | undefined,
  extra: unknown,
  /** Told when the args fail the target's schema (the refusal log, #618). Absent ⇒ nothing is told. */
  onInvalid?: (name: string, def: any, args: Record<string, unknown>) => void
): Promise<any> {
  const t = registry.get(name);
  if (!t) return fail(new Error(`unknown tool '${name}' — use obsidian_search_tools to list available tools`));
  const parsed = inputObjectOf(t.def.inputSchema).safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    onInvalid?.(name, t.def, args ?? {});
    return fail(new Error(`invalid args for '${name}': ${issues} — see obsidian_describe_tool`));
  }
  return t.handler(parsed.data, extra);
}

/**
 * Register the three meta-tools. `register` defaults to server.registerTool
 * but buildMcpServer passes the ORIGINAL (pre-monkey-patch) registerTool so
 * the meta-tools bypass both the guard wrapper and the capture registry —
 * see the code-mode block in server.ts for why.
 */
export function registerCodeModeTools(
  server: McpServer,
  registry: CapturedRegistry,
  register?: (name: string, def: unknown, handler: unknown) => unknown,
  /** Passed to callCapturedTool: told when a target call fails its schema (the refusal log, #618). */
  onInvalid?: (name: string, def: any, args: Record<string, unknown>) => void
): void {
  const reg: any = register ?? (server.registerTool as any).bind(server);
  reg(
    "obsidian_search_tools",
    {
      title: "Search available vault tools",
      description:
        "This session runs in Code Mode: the full Vault MCP tool set is behind three meta-tools. " +
        "Search the available tools by keyword (matched against name, title, and description); no query lists all. " +
        "Then obsidian_describe_tool for a tool's parameters, and obsidian_call_tool to run it.",
      inputSchema: {
        query: z.string().optional().describe("Keyword filter, e.g. 'backlinks', 'frontmatter', 'move'. Omit to list every tool."),
      },
      annotations: RO,
    },
    async (args: { query?: string }) => {
      const tools = searchRegistry(registry, args.query);
      return ok({ count: tools.length, tools });
    }
  );

  reg(
    "obsidian_describe_tool",
    {
      title: "Describe a vault tool",
      description: "Full description, annotations, and input JSON Schema for one tool (by exact name from obsidian_search_tools).",
      inputSchema: {
        name: z.string().min(1).describe("Exact tool name, e.g. 'obsidian_read_note'."),
      },
      annotations: RO,
    },
    async (args: { name: string }) => {
      const d = describeTool(registry, args.name);
      if (!d) return fail(new Error(`unknown tool '${args.name}' — use obsidian_search_tools to list available tools`));
      return ok(d);
    }
  );

  reg(
    "obsidian_call_tool",
    {
      title: "Call a vault tool by name",
      description:
        "Invoke any Vault MCP tool by exact name with a JSON args object (shape per obsidian_describe_tool). " +
        "Safety rails (read-only mode, path allowlist) apply to the target tool exactly as on the full surface.",
      inputSchema: {
        name: z.string().min(1).describe("Exact tool name from obsidian_search_tools."),
        args: z.record(z.unknown()).optional().describe("Arguments for the target tool; validated against its schema."),
      },
      // The TARGET's guard wrapper enforces read-only/allowlist per call; the
      // meta-tool itself is a dispatcher, honestly annotated as possibly-mutating.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args: { name: string; args?: Record<string, unknown> }, extra: unknown) =>
      callCapturedTool(registry, args.name, args.args, extra, onInvalid)
  );
}
