import { getSettings } from '../config/settings.js';
import { callInfo, callWarn } from '../core/call-logger.js';
import {
  getCallLogRepository,
  isDatabaseEnabled,
} from '../db/call-log-repository.js';
import { purgeExpiredCallResultFiles } from './persist-call-result.js';

export interface RetentionPurgeResult {
  transcriptsCleared: number;
  filesRemoved: number;
  retentionDays: number;
}

/**
 * Clears expired DB transcripts and old local JSON snapshots.
 * Safe to call frequently (best-effort after each call + cron/script).
 */
export async function purgeExpiredCallData(
  retentionDays = getSettings().callDataRetentionDays,
): Promise<RetentionPurgeResult> {
  let transcriptsCleared = 0;
  let filesRemoved = 0;

  if (isDatabaseEnabled()) {
    try {
      transcriptsCleared =
        await getCallLogRepository().purgeExpiredTranscripts(retentionDays);
    } catch (error) {
      callWarn(`[CALL] retention.transcript_purge_fail error=${error}`);
    }
  }

  try {
    filesRemoved = await purgeExpiredCallResultFiles(retentionDays);
  } catch (error) {
    callWarn(`[CALL] retention.file_purge_fail error=${error}`);
  }

  if (transcriptsCleared > 0 || filesRemoved > 0) {
    callInfo(
      `[CALL] retention.purged days=${retentionDays} transcripts=${transcriptsCleared} files=${filesRemoved}`,
    );
  }

  return { transcriptsCleared, filesRemoved, retentionDays };
}
