// SESSIONS — the published contract (WP5, D01; suite-split S3, condition 7).
//
// A session binds a connection, a local actor, a base state, a scope, and the
// current replica. D01's ruling shapes everything here: **sessions are
// replica-local** — the identifier is globally unique and may be LINKED
// across devices (`continuedFrom`, `relatedSessions`), but a link transfers
// no capability. Another device opens its OWN session with its own actor
// binding, base state, expiry, and receipts. "An attestation or cohort may be
// portable; the live session capability is not."
//
// Status transitions are one-way. There is no resurrect: an expired or
// revoked session is evidence about the past, and a new session is cheap.
// Expiry is decided AT USE (dequeue, admission) against a caller-supplied
// clock — no timers, nothing here reads the wall clock.
//
// PUBLISHED HERE (@vault-mcp/core) since the suite split's S3 (condition 7,
// ruled 2026-08-27: "the HOST keeps minting... SessionV1 therefore becomes a
// published contract, not provider-internal"). A session is TRANSPORT state —
// the host is the only thing that knows a connection began, it computes the
// connection's scope digest, and it closes the session when the socket
// drops. So `SessionV1`, its status transitions, and its clock-expiry floor
// live here as a contract both plugin artifacts can import; the host's own
// MINTING logic (`openSession`, which needs a host-local uuidv7) stays in the
// plugin at `src/kernel/sessions/session.ts`, and the provider's
// `session-store.ts` (the durable event log and revocation state) stays with
// the provider — only the type and its pure transition helpers moved.
//
// What the PROVIDER owns is REFUSAL: revocation state, answered through the
// seam's refusal-shaped session hook (`registerSessionRefusal`, mcp/seam.ts).
// The host never asks a provider for permission — only whether it wants to
// refuse — and an absent provider constrains nothing.

// The branded session identifier.
declare const brand: unique symbol;
export type SessionId = string & { readonly [brand]: "session" };

/**
 * How long a session lives without explicit closure. Generous on purpose: the
 * cost of an expired-but-active session is one typed refusal and a reconnect,
 * while the cost of an eternal session is an authority context that outlives
 * anyone's memory of opening it. Mandates (WP9) carry their own, tighter
 * budgets — this is the OUTER bound for ungoverned-posture work.
 */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type SessionStatus = "open" | "closed" | "expired" | "revoked";

export interface SessionV1 {
  schema: "governor.session/v1";
  id: SessionId;
  /** Which vault this session speaks about. */
  vaultId: string;
  /** The install id of THIS replica — sessions never span replicas (D01). */
  replicaId: string;
  /**
   * The transport-established actor. Never client-claimed. `clientClaim` is
   * what was known AT OPEN — for a real MCP connection that is null, because
   * the client's initialize handshake happens after the server (and session)
   * is built. The journal actor resolves the live client per call; the two
   * records deliberately answer different questions ("who opened this" vs
   * "who was speaking when this landed").
   */
  actor: { connection: string; clientClaim: string | null };
  /**
   * Where the vault stood when the session opened — the journal's head
   * position, or null when the journal was empty/unavailable. Evidence for
   * later reconciliation, not a lock.
   */
  baseState: { journalHead: string | null };
  /** Digest of the effective connection scope at open. A session cannot widen it. */
  scopeDigest: string;
  openedAt: number;
  expiresAt: number;
  /** Set only when work runs under a mandate (WP9). */
  mandateId: string | null;
  /**
   * Lineage links. A link is a FACT about relatedness, never a capability:
   * nothing may derive scope, mandate, or liveness through one — the opening
   * input carries no fields to inherit, which is the enforcement.
   */
  continuedFrom: SessionId | null;
  relatedSessions: SessionId[];
  status: SessionStatus;
  /** Present only on revoked sessions. */
  revokedReason?: string;
}

/** A session may not be used after transitioning out of `open`. */
export class SessionNotLiveError extends Error {
  readonly code = "session_not_live";
  constructor(readonly sessionId: string, readonly status: SessionStatus) {
    super(`session ${sessionId} is ${status}; open a new session rather than reviving this one`);
    this.name = "SessionNotLiveError";
  }
}

/**
 * Liveness, decided at use. An open session past its expiry is NOT live —
 * expiry needs no writer to have happened, which is what makes the
 * at-dequeue and at-admission checks meaningful after a crash or a sleep.
 */
export function isLive(session: SessionV1, now: number): boolean {
  return session.status === "open" && now < session.expiresAt;
}

/** Why a session is not live, for typed refusals. */
export function livenessOf(session: SessionV1, now: number): SessionStatus {
  if (session.status !== "open") return session.status;
  return now < session.expiresAt ? "open" : "expired";
}

/**
 * The instruction every session refusal carries. When vault-mcp refuses, an
 * agent's easy way out is to write the vault file directly, which skips the
 * queue, the journal and the version checks (01.43 rule 7) and clashes with
 * Linter. So the refusal says what to do instead.
 */
export const NO_DIRECT_WRITES = "Do not write vault files directly; stop and retry, then report to your superior.";

/**
 * THE HOST'S OWN FLOOR at dequeue: a typed refusal when this connection's
 * session has run out, or `null` when it has not.
 *
 * Refusal-shaped rather than boolean for the same reason the seam's session
 * hook is (condition 2): every answer on this path is either a refusal or
 * silence, and a type that can also say YES is a type someone can eventually
 * talk into saying yes. `null` here means "the host has nothing to add", which
 * is exactly what it means coming back from the seam — so server.ts composes
 * the two by taking the first refusal, and neither can un-refuse the other.
 *
 * Pure: `now` is supplied, no store is read, and no session at all is not an
 * error. Expiry needs no writer and no durable record to have HAPPENED, which
 * is what lets a host with no governance provider installed still stop
 * honouring a session that ran out while its connection stayed open.
 */
export function expiryRefusal(
  session: SessionV1 | null,
  now: number
): { code: string; detail: string; status: SessionStatus } | null {
  if (!session) return null;
  if (isLive(session, now)) return null;
  const status = livenessOf(session, now);
  return {
    code: "session_not_live",
    // Only an expiry is replaced on the next call; a closed or revoked session
    // never is, so its text does not tell the caller to retry.
    detail:
      status === "expired"
        ? `this connection's session (${session.id}) is expired; retry the call (an expired session is replaced by a new one on the next call) or reconnect to open a new session. ${NO_DIRECT_WRITES}`
        : `this connection's session (${session.id}) is ${status}; reconnect to open a new session. Do not write vault files directly; stop and report to your superior.`,
    status,
  };
}

/**
 * Bind a governing mandate to a live session (WP9). Set ONCE, by mandate
 * activation only — the pane's activation gesture is the sole caller path.
 * A session cannot swap mandates mid-flight: replacing the mandate is
 * amendment-by-replacement on the MANDATE side, and the successor mandate's
 * delegate binding decides which sessions run under it.
 */
export function attachMandate(session: SessionV1, mandateId: string): SessionV1 {
  if (session.status !== "open") throw new SessionNotLiveError(session.id, session.status);
  if (!mandateId) throw new Error("attachMandate requires a mandate id");
  if (session.mandateId !== null) {
    throw new Error(`session ${session.id} already runs under mandate ${session.mandateId}; a session's mandate is set once`);
  }
  return { ...session, mandateId };
}

export function closeSession(session: SessionV1): SessionV1 {
  if (session.status !== "open") throw new SessionNotLiveError(session.id, session.status);
  return { ...session, status: "closed" };
}

export function revokeSession(session: SessionV1, reason: string): SessionV1 {
  // Revoking a closed/expired session is allowed and idempotent in effect —
  // revocation is a human statement of distrust, and "already inert" is not a
  // reason to refuse recording it — but a revoked session stays revoked.
  if (session.status === "revoked") return session;
  return { ...session, status: "revoked", revokedReason: reason };
}

/** The expiry transition, made explicit for the durable record. */
export function expireSession(session: SessionV1, now: number): SessionV1 {
  if (session.status !== "open") return session;
  if (now < session.expiresAt) throw new Error(`session ${session.id} has not expired yet`);
  return { ...session, status: "expired" };
}
