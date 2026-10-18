// rate-limit.ts — a small fixed-window rate limit for /mcp (#521, the Funnel road of 00.02).
//
// Two limits, each per minute:
//   VAULT_MCP_RATE_IP_PER_MIN    — per client IP, checked BEFORE auth, so a guesser is slowed too (default 300);
//   VAULT_MCP_RATE_CRED_PER_MIN  — per authenticated credential id, checked after auth (default 120).
// 0 turns that limit off. A refused request gets 429 with Retry-After (seconds to the window's end).
//
// The client IP is Express's `req.ip`, so it depends on the app's "trust proxy" setting (front.ts):
// by default only a loopback peer (tailscale serve, cloudflared) may name the client in
// X-Forwarded-For. In memory, one process: the front is one process per host.

import type { Request, Response, NextFunction, RequestHandler } from "express";

export interface RateLimitConfig {
  ipPerMin: number;
  credPerMin: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = { ipPerMin: 300, credPerMin: 120 };

function intFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function loadRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    ipPerMin: intFrom(env.VAULT_MCP_RATE_IP_PER_MIN, DEFAULT_RATE_LIMITS.ipPerMin),
    credPerMin: intFrom(env.VAULT_MCP_RATE_CRED_PER_MIN, DEFAULT_RATE_LIMITS.credPerMin),
  };
}

const WINDOW_MS = 60_000;
/** Above this many keys, expired windows are swept before a new key is added. */
const SWEEP_AT = 10_000;

/** A fixed-window counter: `hit(key)` is null when allowed, else the seconds until the window ends. */
export function createWindowCounter(limit: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key: string): number | null {
      if (limit <= 0) return null;
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= WINDOW_MS) {
        if (!w && windows.size >= SWEEP_AT) {
          for (const [k, v] of windows) if (t - v.start >= WINDOW_MS) windows.delete(k);
        }
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      if (w.count <= limit) return null;
      return Math.max(1, Math.ceil((w.start + WINDOW_MS - t) / 1000));
    },
    size: () => windows.size,
  };
}

function send429(res: Response, retryAfter: number): void {
  res
    .status(429)
    .set("Retry-After", String(retryAfter))
    .json({ jsonrpc: "2.0", error: { code: -32029, message: "rate limited; retry later" }, id: null });
}

/** Per client IP; mount before the auth gate. */
export function createIpRateLimit(limit: number, now?: () => number): RequestHandler {
  const counter = createWindowCounter(limit, now);
  return (req: Request, res: Response, next: NextFunction): void => {
    const wait = counter.hit(req.ip ?? "unknown");
    if (wait !== null) return send429(res, wait);
    next();
  };
}

/** Per credential id (res.locals, from the auth gate); mount after it. */
export function createCredentialRateLimit(limit: number, credentialOf: (res: Response) => string | undefined, now?: () => number): RequestHandler {
  const counter = createWindowCounter(limit, now);
  return (_req: Request, res: Response, next: NextFunction): void => {
    const wait = counter.hit(credentialOf(res) ?? "anonymous");
    if (wait !== null) return send429(res, wait);
    next();
  };
}
