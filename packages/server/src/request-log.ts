// request-log.ts — one JSON line per /mcp request (#521, the Funnel road of 00.02).
//
// Each line: {"time","ip","credential","profile","http","rpc","tool","status","ms"}.
//   credential — the credential ID ("token", "sub:<subject>"), never the token itself;
//   rpc        — the JSON-RPC method (an array for a batch), when the body was parsed;
//   tool       — the tool name of a tools/call (an array for a batch), else absent.
// No note content and no arguments are ever written. Names a client sends are cut to a safe
// alphabet and length, so the log cannot be used to smuggle content in.
//
// The file is VAULT_MCP_REQUEST_LOG (a path, or "off"), by default
// $XDG_STATE_HOME/vault-mcp-remote/requests.jsonl (~/.local/state/... when XDG_STATE_HOME is unset).
// When a line would take it past VAULT_MCP_REQUEST_LOG_MAX_BYTES (default 10 MB) it is rotated to
// requests.jsonl.1 (the older .1 to .2, and so on, keeping 3).

import { appendFileSync, mkdirSync, renameSync, statSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Request, Response, NextFunction, RequestHandler } from "express";

export const REQUEST_LOG_ENV_VAR = "VAULT_MCP_REQUEST_LOG";
export const REQUEST_LOG_MAX_ENV_VAR = "VAULT_MCP_REQUEST_LOG_MAX_BYTES";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 3;

export interface RequestLogConfig {
  /** Absolute file path, or null when the log is off. */
  file: string | null;
  maxBytes: number;
}

export function loadRequestLogConfig(env: NodeJS.ProcessEnv = process.env): RequestLogConfig {
  const raw = env[REQUEST_LOG_ENV_VAR]?.trim();
  const max = Number(env[REQUEST_LOG_MAX_ENV_VAR]);
  const maxBytes = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_BYTES;
  if (raw && ["off", "0", "false", "no"].includes(raw.toLowerCase())) return { file: null, maxBytes };
  if (raw) return { file: path.resolve(raw), maxBytes };
  const state = env.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local", "state");
  return { file: path.join(state, "vault-mcp-remote", "requests.jsonl"), maxBytes };
}

/** A name a client sent, cut to `[A-Za-z0-9_./:-]` and 100 characters. */
function safeName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[^A-Za-z0-9_./:-]/g, "?").slice(0, 100);
  return s || undefined;
}

/** The JSON-RPC methods and tools/call names of a parsed body — nothing else is read from it. */
export function rpcSummary(body: unknown): { rpc?: string | string[]; tool?: string | string[] } {
  const msgs = Array.isArray(body) ? body.slice(0, 50) : body && typeof body === "object" ? [body] : [];
  const methods: string[] = [];
  const tools: string[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const method = safeName((m as { method?: unknown }).method);
    if (method) methods.push(method);
    if (method === "tools/call") {
      const name = safeName((m as { params?: { name?: unknown } }).params?.name);
      if (name) tools.push(name);
    }
  }
  const one = (xs: string[]) => (xs.length === 0 ? undefined : Array.isArray(body) ? xs : xs[0]);
  const rpc = one(methods);
  const tool = one(tools);
  return { ...(rpc !== undefined ? { rpc } : {}), ...(tool !== undefined ? { tool } : {}) };
}

/** Append one line, rotating first when the line would take the file past the cap. */
export function createLogWriter(cfg: RequestLogConfig): (line: string) => void {
  if (!cfg.file) return () => undefined;
  const file = cfg.file;
  let dirMade = false;
  return (line: string) => {
    try {
      if (!dirMade) {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        dirMade = true;
      }
      const bytes = Buffer.byteLength(line) + 1;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + bytes > cfg.maxBytes) {
        const oldest = `${file}.${KEEP}`;
        if (existsSync(oldest)) unlinkSync(oldest);
        for (let i = KEEP - 1; i >= 1; i--) {
          if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        }
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line + "\n", { mode: 0o600 });
    } catch (e) {
      // A log that cannot be written must not take the endpoint down; say so once per failure.
      console.error("[front] request log write failed:", (e as Error).message);
    }
  };
}

/**
 * Express middleware, mounted FIRST on /mcp so refused requests (401, 403, 429) are logged too.
 * It reads the credential and profile the later gates leave in res.locals, and the parsed body,
 * when the response finishes.
 */
export function createRequestLog(
  write: (line: string) => void,
  read: { credential: (res: Response) => string | undefined; profile: (res: Response) => string | undefined },
  now: () => number = Date.now
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = now();
    res.on("finish", () => {
      const entry = {
        time: new Date(start).toISOString(),
        ip: req.ip ?? null,
        credential: read.credential(res) ?? null,
        profile: read.profile(res) ?? null,
        http: req.method,
        ...rpcSummary(req.body),
        status: res.statusCode,
        ms: now() - start,
      };
      write(JSON.stringify(entry));
    });
    next();
  };
}
