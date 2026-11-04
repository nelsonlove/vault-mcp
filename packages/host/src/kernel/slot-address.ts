// slot-address.ts — the shape of a bare slot address used as a note title (a made-up "50.03"), which
// obsidian_create_note renames from the slot class: the address, a space, then the slot's title. One pattern for the
// create tool and for the Sync guard, which must predict the note's path before the tool runs.

/** A bare slot address: two letters or digits, a dot, two digits. */
export const SLOT_ADDRESS_RE = /^[A-Z0-9]{2}\.\d{2}$/;
