/** Tunable call timing — one place to adjust latency vs reliability trade-offs. */

export const GOODBYE_PLAYOUT_TIMEOUT_MS = 20_000;
export const GOODBYE_SIP_DRAIN_GRACE_MS = 3_000;
/** Leave the tool stack before we interrupt and play the scripted closing. */
export const HANGUP_DEFER_MS = 200;
export const CLOSE_FALLBACK_TIMEOUT_MS = 1500;
export const OWNER_OPENING_WAIT_MS = 1000;
export const OUTBOUND_ENDPOINTING_MIN_MS = 1500;
/** Fallback when STT marks a turn final but LiveKit has not ended the turn yet. */
export const TURN_COMMIT_FALLBACK_MS = 1500;
/** After opening, hang up if the owner gives no final STT within this window. */
export const OWNER_RESPONSE_TIMEOUT_MS = 30_000;
/** Default minimum gap between dials to the same property or phone number (7 days). */
export const DEFAULT_DISPATCH_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum pause between consecutive outbound dials in a voice-cron batch (3 minutes). */
export const DEFAULT_DISPATCH_SPACING_MS = 3 * 60 * 1000;
/** Skip GullyNest properties voice-contacted within this window. */
export const VOICE_RECONTACT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Property statuses the voice cron must request explicitly from GullyNest.
 * The API defaults to LIVE only when `status` is omitted — SOFT_STALE is not included
 * unless we pass it in the query.
 */
export const VOICE_CRON_PROPERTY_STATUSES = ['LIVE', 'SOFT_STALE'] as const;
/** Voice cron only calls owner-listed properties — not tenant or agent listings. */
export const VOICE_CRON_LISTING_KIND = 'OWNER';
