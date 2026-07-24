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
/** After opening, hang up if the owner gives no final STT within this window. */
export const OWNER_RESPONSE_TIMEOUT_MS = 30_000;
/** Default minimum gap between dials to the same property or phone number. */
export const DEFAULT_DISPATCH_COOLDOWN_MS = 86_400_000;
