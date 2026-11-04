// slot-address.ts — the shape of a bare slot address used as a note title ("00.08"), which
// obsidian_create_note names from the slot class ("00.08 Audits & reports"). One pattern for the
// create tool and for the Sync guard, which must predict the note's path before the tool runs.

/** A bare slot address: two letters or digits, a dot, two digits. */
export const SLOT_ADDRESS_RE = /^[A-Z0-9]{2}\.\d{2}$/;
