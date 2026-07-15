import { eq } from 'drizzle-orm';
import { callWarn } from '../core/call-logger.js';
import type {
  CallLogSnapshot,
  TranscriptEntry,
} from '../jobs/call-log-types.js';
import { isSuccessfulOutcome } from '../jobs/call-log-types.js';
import type { PropertyAvailabilityCallJob } from '../jobs/models.js';
import type { DispatchResult } from '../jobs/models.js';
import { getDb, isDatabaseEnabled } from './client.js';
import { callLogs, type CallLogRow } from './schema.js';

function emptyTranscriptDefaults(): {
  languages: string[];
  transcript: TranscriptEntry[];
  metadata: Record<string, unknown>;
} {
  return { languages: [], transcript: [], metadata: {} };
}

export class CallLogRepository {
  async upsertDispatched(
    job: PropertyAvailabilityCallJob,
    dispatch: DispatchResult,
  ): Promise<void> {
    if (!isDatabaseEnabled()) return;

    const db = getDb();
    const now = new Date();
    const base = emptyTranscriptDefaults();

    await db
      .insert(callLogs)
      .values({
        jobId: job.jobId,
        direction: 'outbound',
        status: 'dispatched',
        ownerOutcome: 'not_asked',
        success: false,
        answered: false,
        phoneNumber: job.owner.phoneNumber,
        ownerName: job.owner.name,
        propertyId: job.property.propertyId,
        propertyAddress: job.property.address,
        callerName: job.callerName,
        companyName: job.companyName,
        roomName: dispatch.roomName,
        dispatchId: dispatch.dispatchId,
        languages: base.languages,
        transcript: base.transcript,
        metadata: {
          ...(job.metadata ?? {}),
          job_type: 'property_availability',
          preferred_language: job.preferredLanguage,
        },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: callLogs.jobId,
        set: {
          status: 'dispatched',
          roomName: dispatch.roomName,
          dispatchId: dispatch.dispatchId,
          updatedAt: now,
        },
      });
  }

  async markInProgress(jobId: string): Promise<void> {
    if (!isDatabaseEnabled()) return;

    const db = getDb();
    const now = new Date();
    await db
      .update(callLogs)
      .set({
        status: 'in_progress',
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(callLogs.jobId, jobId));
  }

  async markAnswered(jobId: string): Promise<void> {
    if (!isDatabaseEnabled()) return;

    const db = getDb();
    await db
      .update(callLogs)
      .set({
        answered: true,
        updatedAt: new Date(),
      })
      .where(eq(callLogs.jobId, jobId));
  }

  async markNoAnswer(jobId: string, summary: string): Promise<void> {
    await this.complete({
      jobId,
      direction: 'outbound',
      status: 'no_answer',
      ownerOutcome: 'other',
      success: false,
      answered: false,
      transcriptSummary: summary,
      languages: [],
      transcript: [],
      metadata: {},
    });
  }

  async markFailed(jobId: string, summary: string): Promise<void> {
    await this.complete({
      jobId,
      direction: 'outbound',
      status: 'failed',
      ownerOutcome: 'other',
      success: false,
      answered: false,
      transcriptSummary: summary,
      languages: [],
      transcript: [],
      metadata: {},
    });
  }

  async complete(snapshot: CallLogSnapshot): Promise<void> {
    if (!isDatabaseEnabled()) return;

    const db = getDb();
    const now = new Date();
    const success =
      snapshot.status === 'completed' && isSuccessfulOutcome(snapshot.ownerOutcome);

    await db
      .insert(callLogs)
      .values({
        jobId: snapshot.jobId,
        direction: snapshot.direction,
        status: snapshot.status,
        ownerOutcome: snapshot.ownerOutcome,
        success,
        answered: snapshot.answered,
        phoneNumber: snapshot.phoneNumber,
        ownerName: snapshot.ownerName,
        propertyId: snapshot.propertyId,
        propertyAddress: snapshot.propertyAddress,
        callerName: snapshot.callerName,
        companyName: snapshot.companyName,
        roomName: snapshot.roomName,
        dispatchId: snapshot.dispatchId,
        languages: snapshot.languages,
        transcript: snapshot.transcript,
        transcriptSummary: snapshot.transcriptSummary,
        metadata: snapshot.metadata,
        startedAt: snapshot.startedAt ? new Date(snapshot.startedAt) : undefined,
        completedAt: snapshot.completedAt ? new Date(snapshot.completedAt) : now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: callLogs.jobId,
        set: {
          status: snapshot.status,
          ownerOutcome: snapshot.ownerOutcome,
          success,
          answered: snapshot.answered,
          languages: snapshot.languages,
          transcript: snapshot.transcript,
          transcriptSummary: snapshot.transcriptSummary,
          metadata: snapshot.metadata,
          completedAt: snapshot.completedAt ? new Date(snapshot.completedAt) : now,
          updatedAt: now,
        },
      });
  }

  async getByJobId(jobId: string): Promise<CallLogRow | null> {
    if (!isDatabaseEnabled()) return null;

    const db = getDb();
    const rows = await db.select().from(callLogs).where(eq(callLogs.jobId, jobId)).limit(1);
    return rows[0] ?? null;
  }

  async listRecent(limit = 50): Promise<CallLogRow[]> {
    if (!isDatabaseEnabled()) return [];

    const db = getDb();
    return db.select().from(callLogs).limit(limit);
  }
}

let singleton: CallLogRepository | null = null;

export function getCallLogRepository(): CallLogRepository {
  if (!singleton) {
    singleton = new CallLogRepository();
  }
  return singleton;
}

export async function safeCompleteCallLog(snapshot: CallLogSnapshot): Promise<void> {
  try {
    await getCallLogRepository().complete(snapshot);
  } catch (error) {
    callWarn(`[CALL] call_log.complete_fail job=${snapshot.jobId} error=${error}`);
  }
}

export async function safeMarkCallInProgress(jobId: string): Promise<void> {
  try {
    await getCallLogRepository().markInProgress(jobId);
  } catch (error) {
    callWarn(`[CALL] call_log.in_progress_fail job=${jobId} error=${error}`);
  }
}

export async function safeMarkCallAnswered(jobId: string): Promise<void> {
  try {
    await getCallLogRepository().markAnswered(jobId);
  } catch (error) {
    callWarn(`[CALL] call_log.answered_fail job=${jobId} error=${error}`);
  }
}

export async function safeMarkCallNoAnswer(jobId: string, summary: string): Promise<void> {
  try {
    await getCallLogRepository().markNoAnswer(jobId, summary);
  } catch (error) {
    callWarn(`[CALL] call_log.no_answer_fail job=${jobId} error=${error}`);
  }
}

export async function safeMarkCallFailed(jobId: string, summary: string): Promise<void> {
  try {
    await getCallLogRepository().markFailed(jobId, summary);
  } catch (error) {
    callWarn(`[CALL] call_log.failed_fail job=${jobId} error=${error}`);
  }
}

export async function safeUpsertDispatched(
  job: PropertyAvailabilityCallJob,
  dispatch: DispatchResult,
): Promise<void> {
  try {
    await getCallLogRepository().upsertDispatched(job, dispatch);
  } catch (error) {
    callWarn(`[CALL] call_log.dispatch_fail job=${job.jobId} error=${error}`);
  }
}

export { closeDb, isDatabaseEnabled } from './client.js';
