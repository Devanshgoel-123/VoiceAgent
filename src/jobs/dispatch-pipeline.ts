import type { Settings } from '../config/settings.js';
import {
  getCallLogRepository,
  isDatabaseEnabled,
  ReserveDispatchError,
} from '../db/call-log-repository.js';
import { createGullyNestClientFromSettings } from '../integrations/gullynest/client.js';
import { evaluateDispatchCompliance } from './compliance.js';
import { CallJobDispatcher } from './dispatcher.js';
import type {
  DispatchResult,
  PropertyAvailabilityCallJob,
} from './models.js';

export type SecureDispatchFailure =
  | {
      kind: 'compliance';
      status: 403;
      error: string;
      reason: string;
    }
  | {
      kind: 'conflict';
      status: 409;
      error: string;
      existingJobId?: string;
      existingStatus?: string;
    }
  | {
      kind: 'database_required' | 'dispatch_failed';
      status: 503;
      error: string;
    };

export type SecureDispatchResult =
  | { ok: true; result: DispatchResult }
  | { ok: false; failure: SecureDispatchFailure };

export interface SecureDispatchOptions {
  /** Skip the recent-call cooldown check (still enforces the active-call conflict check). */
  forced?: boolean;
}

/**
 * Fail-closed dispatch: requires DB, enforces quiet hours + suppression,
 * atomically reserves (property_id, phone_number), then creates LiveKit dispatch.
 */
export async function secureDispatchPropertyAvailabilityCall(
  job: PropertyAvailabilityCallJob,
  settings: Settings,
  dispatcher: CallJobDispatcher = new CallJobDispatcher(settings),
  options?: SecureDispatchOptions,
): Promise<SecureDispatchResult> {
  if (!isDatabaseEnabled()) {
    return {
      ok: false,
      failure: {
        kind: 'database_required',
        status: 503,
        error:
          'DATABASE_URL is required for outbound dispatch (atomic lock + compliance)',
      },
    };
  }

  const repo = getCallLogRepository();
  let suppressed: boolean;
  try {
    suppressed = await repo.isPhoneSuppressed(job.owner.phoneNumber);
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'dispatch_failed',
        status: 503,
        error: `Compliance check failed: ${error}`,
      },
    };
  }

  const compliance = evaluateDispatchCompliance({
    settings,
    isSuppressed: suppressed,
  });
  if (!compliance.allowed) {
    return {
      ok: false,
      failure: {
        kind: 'compliance',
        status: 403,
        error: compliance.detail ?? 'Call blocked by compliance policy',
        reason: compliance.reason ?? 'suppressed',
      },
    };
  }

  try {
    await repo.reserveDispatchSlot(job, options?.forced ? 0 : settings.dispatchCooldownMs);
  } catch (error) {
    if (error instanceof ReserveDispatchError) {
      return {
        ok: false,
        failure: {
          kind: 'conflict',
          status: 409,
          error: error.message,
          existingJobId: error.existing?.jobId,
          existingStatus: error.existing?.status,
        },
      };
    }
    return {
      ok: false,
      failure: {
        kind: 'dispatch_failed',
        status: 503,
        error: `Failed to reserve dispatch slot: ${error}`,
      },
    };
  }

  try {
    const result = await dispatcher.dispatchPropertyAvailabilityCall(job);
    await repo.attachDispatch(job.jobId, {
      roomName: result.roomName,
      dispatchId: result.dispatchId,
    });

    // Best-effort: lets GullyNest's own contactedBefore filter exclude this
    // property immediately, instead of only learning about it once the call
    // completes (reportCallOutcome). Never fails the dispatch — correctness
    // is already guaranteed by the reservation above, this is purely freshness.
    const gullyClient = createGullyNestClientFromSettings(settings);
    if (gullyClient) {
      try {
        await gullyClient.markContacted(job.property.propertyId);
      } catch (markContactedError) {
        console.warn(
          `gullynest mark-contacted failed property=${job.property.propertyId}: ${markContactedError}`,
        );
      }
    }

    return { ok: true, result };
  } catch (error) {
    try {
      await repo.releaseReservation(job.jobId, `Dispatch failed: ${error}`);
    } catch (releaseError) {
      console.error('Failed to release reservation after dispatch error:', releaseError);
    }
    return {
      ok: false,
      failure: {
        kind: 'dispatch_failed',
        status: 503,
        error: `LiveKit dispatch failed: ${error}`,
      },
    };
  }
}
