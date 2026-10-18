// The provider's answer to the host's session-refusal hook.
//
// Revocation is a human act landing in this plugin's own session store, so this
// plugin is what notices it, and the host learns only "refused, and here is the
// coded reason".
//
// A store read that FAILS is answered by purpose (the second argument, which
// older hosts do not pass):
//
//   • "dequeue" (the default): silence. The write degrades to the host's own
//     expiry floor rather than wedging every write in the vault behind a
//     corrupted `sessions.jsonl`. Missing a revocation on a transient read error
//     is what this code did before the seam existed; refusing every write is
//     not.
//   • "rotate": a REFUSAL. The host asks this before it replaces an expired
//     session with a new one, and a rotation needs a positive "not revoked".
//     Silence there would let a revoked session's connection rotate past its
//     revocation whenever the store could not be read. Refusing costs only the
//     rotation: the connection keeps its expired session and refuses, as it did
//     before rotation existed.

import type { SeamRefusal, SessionRefusalHook } from "vault-mcp-api";

export interface RevocationSource {
  revocationRefusal(sessionId: string): Promise<SeamRefusal | null>;
}

export function sessionRefusalFrom(store: RevocationSource): SessionRefusalHook {
  return async (sessionId, purpose): Promise<SeamRefusal | null> => {
    if (!sessionId) return null;
    try {
      return await store.revocationRefusal(sessionId);
    } catch (e) {
      if (purpose === "rotate") {
        return {
          code: "session_store_unreadable",
          detail: `the governance provider could not read its session store, so session ${sessionId} is not rotated (it may be revoked): ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
      console.error("[governor] session store read failed; falling back to the host's expiry floor", e);
      return null;
    }
  };
}
