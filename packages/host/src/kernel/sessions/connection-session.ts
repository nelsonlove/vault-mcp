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
//   2. the governance provider is asked, through the seam, whether it refuses
//      the OLD id. If it does (a revocation), nothing rotates: the old session
//      stays current, so every later mutation keeps refusing. Only an expiry
//      rotates; a revocation never does;
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
// does nothing.

import { livenessOf, expiryRefusal } from "@vault-mcp/core";
import type { SessionId, SessionV1 } from "@vault-mcp/core";

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
  refuse?: (sessionId: string | null) => Promise<Refusal | null>;
  /** The clock. Defaults to Date.now. */
  now?: () => number;
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
   * The dequeue refusal: the host's expiry floor, then the provider's refusal.
   * It rotates first, so a call queued across the expiry runs under the new
   * session only when nothing refuses; see `refusal` in the body.
   */
  refusal(): Promise<Refusal | null>;
  /** Record that the connection closed, against the session current now. */
  close(): void;
}

export function createConnectionSession(deps: ConnectionSessionDeps): ConnectionSession {
  const clock = deps.now ?? Date.now;
  let session = deps.mint(null, clock());
  deps.log.open(session, clock()).catch((e) => console.error("[vault-mcp] session open failed", e));

  let rotating: Promise<void> | null = null;

  const rotate = async (): Promise<void> => {
    const old = session;
    const now = clock();
    // Only an EXPIRY rotates. A session whose own record says closed or
    // revoked is not `expired` here, and stays as it is.
    if (livenessOf(old, now) !== "expired") return;
    deps.log.markExpired(old.id, now).catch(() => undefined);
    // A revoked session is never rotated: the provider's refusal of the OLD id
    // keeps it current, so the connection keeps refusing. A refuse hook that
    // throws is treated the same way (fail closed): no rotation.
    let refused: Refusal | null;
    try {
      refused = (await deps.refuse?.(old.id)) ?? null;
    } catch {
      return;
    }
    if (refused) return;
    if (session !== old) return;
    const next = deps.mint(old.id, clock());
    session = next;
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
    async refusal() {
      // A mutation can wait in the queue across its session's expiry. The
      // journal actor was taken at enqueue and names the session that was live
      // then, so a rotation HERE would run the write under a session the
      // record does not name. So the dequeue check does not rotate: it refuses
      // as before (the next call rotates at enqueue), and the refusal text
      // says to retry.
      const now = clock();
      const expired = expiryRefusal(session, now);
      if (expired) {
        // The expiry transition is recorded, not merely observed: the durable
        // record should not say "open" about a session nothing will honour.
        if (expired.status === "expired") deps.log.markExpired(session.id, now).catch(() => undefined);
        return { code: expired.code, detail: expired.detail };
      }
      return (await deps.refuse?.(session.id)) ?? null;
    },
    close() {
      deps.log.close(session.id, clock()).catch(() => undefined);
    },
  };
}
