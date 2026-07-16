/** Tunable call timing — one place to adjust latency vs reliability trade-offs. */

export const GOODBYE_PLAYOUT_TIMEOUT_MS = 20_000;
export const GOODBYE_SIP_DRAIN_GRACE_MS = 3_000;
/** Leave the tool stack before we interrupt and play the scripted closing. */
export const HANGUP_DEFER_MS = 200;
export const CLOSE_FALLBACK_TIMEOUT_MS = 1500;
export const OWNER_OPENING_WAIT_MS = 1000;
export const OUTBOUND_ENDPOINTING_MIN_MS = 250;
/** Fallback when STT marks a turn final but LiveKit has not ended the turn yet. */
export const TURN_COMMIT_FALLBACK_MS = 250;
