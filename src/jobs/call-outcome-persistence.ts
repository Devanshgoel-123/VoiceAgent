import { log } from '@livekit/agents';
import { callInfo, callWarn } from '../core/call-logger.js';
import type { Settings } from '../config/settings.js';
import {
  safeAddPhoneSuppression,
  safeCompleteCallLog,
} from '../db/call-log-repository.js';
import { createGullyNestClientFromSettings } from '../integrations/gullynest/client.js';
import {
  mapSnapshotToCallOutcomeAction,
  shouldReportCallOutcome,
} from '../integrations/gullynest/outcome-map.js';
import type { CallLogSnapshot } from './call-log-types.js';
import { saveCallResultSnapshot } from './persist-call-result.js';
import { purgeExpiredCallData } from './retention.js';

type LiveKitLogger = ReturnType<typeof log>;

/**
 * Persists a call's final outcome: DB row, JSON snapshot, GullyNest outcome report
 * (when applicable), and a best-effort retention sweep. Called for every terminal
 * state a job can reach — a completed conversation, a no-answer, a dial failure, or
 * a config error — not just the happy path, so GullyNest's `voiceLastContactedAt`
 * gets stamped regardless of whether the owner ever picked up.
 */
export async function persistCallResult(
  snapshot: CallLogSnapshot,
  settings: Settings,
  logger?: LiveKitLogger,
): Promise<void> {
  await safeCompleteCallLog(snapshot);

  // The closing script promises an opted-out owner we won't call again. An opt-out
  // reports soft_stale, which the cron still dials after the recontact cooldown,
  // so the suppression list is what actually keeps that promise.
  if (snapshot.metadata.do_not_call === true && snapshot.phoneNumber) {
    const ownerRequest = String(snapshot.metadata.do_not_call_reason ?? '').trim();
    await safeAddPhoneSuppression(
      snapshot.phoneNumber,
      `Owner asked not to be called again (job ${snapshot.jobId})${
        ownerRequest ? `: ${ownerRequest}` : ''
      }`.slice(0, 500),
    );
    callInfo(`opt-out: number suppressed job=${snapshot.jobId}`, logger);
  }

  try {
    await saveCallResultSnapshot(snapshot);
  } catch (error) {
    callWarn(`file snapshot failed job=${snapshot.jobId}: ${error}`, logger);
  }

  const gullyClient = createGullyNestClientFromSettings(settings);
  if (gullyClient && shouldReportCallOutcome(snapshot) && snapshot.propertyId) {
    const action = mapSnapshotToCallOutcomeAction(snapshot);
    try {
      await gullyClient.reportCallOutcome(snapshot.propertyId, action);
      callInfo(
        `gullynest outcome reported property=${snapshot.propertyId} action=${action}`,
        logger,
      );
    } catch (error) {
      callWarn(
        `gullynest outcome report failed property=${snapshot.propertyId}: ${error}`,
        logger,
      );
    }
  }

  // Best-effort retention sweep (also run via `npm run db:purge-expired`).
  void purgeExpiredCallData(settings.callDataRetentionDays).catch((error) => {
    callWarn(`retention purge failed: ${error}`, logger);
  });
}
