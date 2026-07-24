import type { Settings } from '../config/settings.js';
import {
  getCallLogRepository,
  isDatabaseEnabled,
  ReserveDispatchError,
} from '../db/call-log-repository.js';
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

/**
 * Fail-closed dispatch: requires DB, enforces quiet hours + preferences,
 * atomically reserves (property_id, phone_number), then creates LiveKit dispatch.
 */
export async function secureDispatchPropertyAvailabilityCall(
  job: PropertyAvailabilityCallJob,
  settings: Settings,
  dispatcher: CallJobDispatcher = new CallJobDispatcher(settings),
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

  let preference;
  let suppressed: boolean;
  try {
    preference = await repo.getCallPreference(job.owner.phoneNumber);
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
    preference,
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
    await repo.reserveDispatchSlot(job, settings.dispatchCooldownMs);
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
