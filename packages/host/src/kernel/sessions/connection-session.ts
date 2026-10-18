// ONE CONNECTION'S SESSION, AND ITS ROTATION ON EXPIRY.
//
// A connection opens one session when it is built (server.ts). The session has a
// fixed TTL (`SESSION_TTL_MS`), counted from the connect. A Claude Code session
// can hold its bridge connection open for days, so before this module existed
// the connection outlived its session: every mutation after the TTL refused with
// `session_not_live` ("reconnect to open a new session"), nothing closed the
// socket, the stdio bridge kept the dead connection, and every write failed
// until the MCP server was restarted by hand. Agents then wrote vault files
// directly, outside the write perimeter (01.43 rule 7).
//
// THE FIX IS A ROTATION, NOT A RESURRECTION. When a call finds its connection's
// session expired while the connection is still open:
//
//   1. the old session is marked expired in the session log (as before);
//   2. the governance provider is asked, through the seam with purpose
//      "rotate", whether it refuses the OLD id. If it does (a revocation, or a
//      store it cannot read: a rotation needs a positive "not revoked"), or its
//      hook throws, or it does not answer within WRITE_TIMEOUT_MS (this check
//      runs in front of the write queue, so it carries its own budget), nothing
//      rotates: the old session stays current, so every later mutation keeps
//      refusing, and the refusal names the provider's reason and says a retry
//      will not help. Only an expiry rotates; a revocation never does;
//   3. otherwise a NEW session is minted with `openSession`, its `continuedFrom`
//      set to the old id, and logged as opened. The connection's later calls,
//      its journal actor, and its close all use the new session.
//
// What this keeps (packages/core/src/session.ts):
//
//   • "Status transitions are one-way. There is no resurrect." The old session
//     is never touched again: its in-memory record still reads expired at any
//     `now` past its expiry, and the log carries its `expired` line. A second,
//     different session is opened, which is exactly what a reconnect did.
//   • "A link is a FACT about relatedness, never a capability." `continuedFrom`
//     is recorded and nothing else: `openSession`'s input cannot carry a
//     mandate, a status, or an expiry, so the new session inherits no mandate
//     and gets its own TTL from its own open.
//   • The scope digest is recomputed from the settings at rotation (the mint
//     callback does it), as a reconnect would, so a narrower allowlist set
//     since the connect is honoured, and nothing can widen past it.
//
// Two concurrent calls that both see the expiry share one rotation: the first
// one's promise is reused, and a call that sees the session already replaced
// does nothing. A closed connection never rotates.
//
// WHEN it runs: `refresh` is awaited at the top of the guarded wrapper, before
// the operation executor builds its record, so the operation's sessionId, the
// journal actor and the write observer all name the same (new) session. The
// DEQUEUE check never rotates: it checks the session the call was ENQUEUED
// under (`refusal(enqueuedUnder)`), so a call queued under a session that then
// expired refuses once, and its retry runs under the new one.

import { livenessOf, expiryRefusal, NO_DIRECT_WRITES } from "@vault-mcp/core";
import type { SessionId, SessionV1 } from "@vault-mcp/core";
import { WRITE_TIMEOUT_MS } from "../write-queue.js";

/** The tail of a refusal for a session that could not be replaced: a retry will not help. */
const NO_RETRY_NO_DIRECT_WRITES = "A retry will not help. Do not write vault files directly; stop and report to your superior.";

type Refusal = { code: string; detail: string };

export interface ConnectionSessionDeps {
  /** The session lifecycle log port (server ctx.sessions). */
  log: {
    open(session: SessionV1, now: number): Promise<void>;
    close(sessionId: string, now: number): Promise<void>;
    markExpired(sessionId: string, now: number): Promise<void>;
  };
  /** Mint a session. `continuedFrom` is null for the connection's first one. */
  mint(continuedFrom: SessionId | null, now: number): SessionV1;
  /** The provider's refusal for a session id, through the seam. Absent: no provider. */
  refuse?: (sessionId: string | null, purpose: "dequeue" | "rotate") => Promise<Refusal | null>;
  /** The clock. Defaults to Date.now. */
  now?: () => number;
  /**
   * How long the provider's "rotate" check may take. It runs in front of the
   * write queue, so the queue's timeout does not bound it; this does, with the
   * same budget (WRITE_TIMEOUT_MS). A timeout counts as a refusal. Tests only.
   */
  rotateCheckTimeoutMs?: number;
}

export interface ConnectionSession {
  /** The session this connection speaks under now. */
  current(): SessionV1;
  /**
   * Rotate when the current session has EXPIRED and the provider does not
   * refuse it. Called before a mutation is queued, so the journal actor names
   * the session the call actually runs under.
   */
  refresh(): Promise<void>;
  /**
   * The dequeue refusal: the host's expiry floor, then the provider's refusal,
   * for the session the call was ENQUEUED under (by id; the current one when
   * none is named). It never rotates.
   */
  refusal(enqueuedUnder?: string | null): Promise<Refusal | null>;
  /** Record that the connection closed, against the session current now. */
  close(): void;
}

export function createConnectionSession(deps: ConnectionSessionDeps): ConnectionSession {
  const clock = deps.now ?? Date.now;
  let session = deps.mint(null, clock());
  deps.log.open(session, clock()).catch((e) => console.error("[vault-mcp] session open failed", e));
  // Every session this connection has held, by id, so the dequeue check can
  // judge a call by the session it was enqueued under.
  const held = new Map<string, SessionV1>([[session.id, session]]);
  let closed = false;
  // The refusal that kept an expired session from rotating, by the old id, so
  // the dequeue check gives the real reason instead of "retry". Cleared when a
  // later rotation of that session goes through.
  const rotationRefused = new Map<string, Refusal>();
  const rotateBudget = deps.rotateCheckTimeoutMs ?? WRITE_TIMEOUT_MS;

  let rotating: Promise<void> | null = null;

  const rotate = async (): Promise<void> => {
    if (closed) return;
    const old = session;
    const now = clock();
    // Only an EXPIRY rotates. A session whose own record says closed or
    // revoked is not `expired` here, and stays as it is.
    if (livenessOf(old, now) !== "expired") return;
    deps.log.markExpired(old.id, now).catch(() => undefined);
    // A revoked session is never rotated: the provider's refusal of the OLD id
    // keeps it current, so the connection keeps refusing. A refuse hook that
    // throws is treated the same way (fail closed): no rotation.
    // The check runs in front of the write queue, so it carries its own
    // budget: a hook that hangs must not wedge this connection's writes (every
    // later mutation awaits this same rotation). A timeout is a refusal.
    let refused: Refusal | null;
    if (deps.refuse) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = Promise.resolve()
        .then(() => deps.refuse!(old.id, "rotate"))
        .then(
          (r): Refusal | null => r ?? null,
          (e): Refusal => ({ code: "session_rotation_failed", detail: `the session provider's rotate check failed: ${e instanceof Error ? e.message : String(e)}` })
        );
      const timeout = new Promise<Refusal>((resolve) => {
        timer = setTimeout(
          () => resolve({ code: "session_rotation_timeout", detail: `the session provider's rotate check did not answer within ${rotateBudget} ms` }),
          rotateBudget
        );
      });
      try {
        refused = await Promise.race([check, timeout]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      refused = null;
    }
    if (refused) {
      rotationRefused.set(old.id, refused);
      return;
    }
    if (session !== old || closed) return;
    rotationRefused.delete(old.id);
    const next = deps.mint(old.id, clock());
    session = next;
    held.set(next.id, next);
    deps.log.open(next, clock()).catch((e) => console.error("[vault-mcp] session open failed", e));
  };

  const refresh = (): Promise<void> => {
    if (!rotating) {
      rotating = rotate().finally(() => {
        rotating = null;
      });
    }
    return rotating;
  };

  return {
    current: () => session,
    refresh,
    async refusal(enqueuedUnder) {
      // Judged against the session the call was ENQUEUED under: the journal
      // actor was taken then and names it. A rotation that happened while the
      // call waited does not lend the call the new session: the old one is
      // expired, so the call refuses once, and its retry runs under the new
      // session. An id this connection never held refuses outright.
      const target = enqueuedUnder == null ? session : held.get(enqueuedUnder);
      if (!target) {
        return { code: "session_not_live", detail: `session ${enqueuedUnder} is not this connection's session. ${NO_DIRECT_WRITES}` };
      }
      const now = clock();
      const expired = expiryRefusal(target, now);
      if (expired) {
        // The expiry transition is recorded, not merely observed: the durable
        // record should not say "open" about a session nothing will honour.
        if (expired.status === "expired") deps.log.markExpired(target.id, now).catch(() => undefined);
        // The connection is still on this session because the provider
        // refused to replace it: a retry would only be refused again.
        const blocked = target === session ? rotationRefused.get(target.id) : undefined;
        if (blocked) {
          return {
            code: expired.code,
            detail: `this connection's session (${target.id}) is expired and could not be replaced (${blocked.code}: ${blocked.detail}). Reconnect to open a new session. ${NO_RETRY_NO_DIRECT_WRITES}`,
          };
        }
        return { code: expired.code, detail: expired.detail };
      }
      return (await deps.refuse?.(target.id, "dequeue")) ?? null;
    },
    close() {
      // No rotation after this: a call still in flight when the connection
      // closed must not open a session nothing will ever close.
      closed = true;
      deps.log.close(session.id, clock()).catch(() => undefined);
    },
  };
}
