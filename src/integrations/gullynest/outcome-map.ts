import type { CallLogSnapshot } from '../../jobs/call-log-types.js';
import type { VoiceCallOutcomeAction } from './types.js';

/**
 * Maps a completed voice call snapshot to a GullyNest call-outcome action.
 * - yes → available (still listed)
 * - no → stale (confirmed unavailable)
 * - ownership mismatch → stale (invalid owner/listing contact)
 * - no-answer / unclear / failed / other → soft_stale
 */
export function mapSnapshotToCallOutcomeAction(
  snapshot: Pick<CallLogSnapshot, 'ownerOutcome' | 'status' | 'metadata'>,
): VoiceCallOutcomeAction {
  if (snapshot.metadata.call_end_reason === 'ownership_mismatch') return 'stale';
  if (snapshot.ownerOutcome === 'yes') return 'available';
  if (snapshot.ownerOutcome === 'no') return 'stale';
  return 'soft_stale';
}

/** Jobs that should never report back to the marketplace. */
export function shouldReportCallOutcome(snapshot: CallLogSnapshot): boolean {
  const propertyId = snapshot.propertyId?.trim();
  if (!propertyId) return false;
  if (snapshot.jobId === 'console-test-job') return false;
  if (propertyId.startsWith('PROP-CONSOLE')) return false;
  return true;
}
