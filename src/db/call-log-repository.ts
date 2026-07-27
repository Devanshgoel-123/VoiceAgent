import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { callWarn } from '../core/call-logger.js';
import type {
  CallLogSnapshot,
  TranscriptEntry,
} from '../jobs/call-log-types.js';
import { isSuccessfulOutcome } from '../jobs/call-log-types.js';
import type { PropertyAvailabilityCallJob } from '../jobs/models.js';
import type { DispatchResult } from '../jobs/models.js';
import { getDb, isDatabaseEnabled } from './client.js';
import {
  callLogs,
  type CallLogRow,
} from './schema.js';

function emptyTranscriptDefaults(): {
  languages: string[];
  transcript: TranscriptEntry[];
  metadata: Record<string, unknown>;
} {
  return { languages: [], transcript: [], metadata: {} };
}

const ACTIVE_STATUSES = ['pending', 'dispatched', 'in_progress'] as const;

function advisoryLockKeys(propertyId: string, phoneNumber: string): [number, number] {
  const digest = createHash('sha256')
    .update(`${propertyId}\0${phoneNumber}`)
    .digest();
  // Two signed 32-bit ints for pg_advisory_xact_lock(int, int)
  const key1 = digest.readInt32BE(0);
  const key2 = digest.readInt32BE(4);
  return [key1, key2];
}

export type ReserveDispatchErrorCode =
  | 'conflict_active'
  | 'conflict_cooldown'
  | 'unique_violation';

export class ReserveDispatchError extends Error {
  readonly code: ReserveDispatchErrorCode;
  readonly existing?: CallLogRow;

  constructor(
    code: ReserveDispatchErrorCode,
    message: string,
    existing?: CallLogRow,
  ) {
    super(message);
    this.name = 'ReserveDispatchError';
    this.code = code;
    this.existing = existing;
  }
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

  /**
   * Atomically reserve a (property_id, phone_number) slot under an advisory lock.
   * Inserts a pending row. Caller must attach dispatch metadata or mark failed.
   */
  async reserveDispatchSlot(
    job: PropertyAvailabilityCallJob,
    cooldownMs: number,
  ): Promise<CallLogRow> {
    if (!isDatabaseEnabled()) {
      throw new Error('DATABASE_URL is required for atomic dispatch reservation');
    }

    const db = getDb();
    const [key1, key2] = advisoryLockKeys(
      job.property.propertyId,
      job.owner.phoneNumber,
    );

    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${key1}, ${key2})`);

      const activeRows = await tx
        .select()
        .from(callLogs)
        .where(
          and(
            inArray(callLogs.status, [...ACTIVE_STATUSES]),
            eq(callLogs.propertyId, job.property.propertyId),
            eq(callLogs.phoneNumber, job.owner.phoneNumber),
          ),
        )
        .limit(1);

      if (activeRows[0]) {
        throw new ReserveDispatchError(
          'conflict_active',
          'A call for this property and phone number is already active',
          activeRows[0],
        );
      }

      const cutoff = new Date(Date.now() - cooldownMs);
      const recentRows = await tx
        .select()
        .from(callLogs)
        .where(
          and(
            gte(callLogs.createdAt, cutoff),
            eq(callLogs.propertyId, job.property.propertyId),
            eq(callLogs.phoneNumber, job.owner.phoneNumber),
          ),
        )
        .limit(1);

      if (recentRows[0]) {
        throw new ReserveDispatchError(
          'conflict_cooldown',
          'A call for this property and phone number was placed recently',
          recentRows[0],
        );
      }

      const now = new Date();
      const base = emptyTranscriptDefaults();
      const inserted = await tx
        .insert(callLogs)
        .values({
          jobId: job.jobId,
          direction: 'outbound',
          status: 'pending',
          ownerOutcome: 'not_asked',
          success: false,
          answered: false,
          phoneNumber: job.owner.phoneNumber,
          ownerName: job.owner.name,
          propertyId: job.property.propertyId,
          propertyAddress: job.property.address,
          callerName: job.callerName,
          companyName: job.companyName,
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
        .returning();

      return inserted[0]!;
    });
  }

  async attachDispatch(
    jobId: string,
    dispatch: Pick<DispatchResult, 'roomName' | 'dispatchId'>,
  ): Promise<void> {
    if (!isDatabaseEnabled()) return;

    const db = getDb();
    await db
      .update(callLogs)
      .set({
        status: 'dispatched',
        roomName: dispatch.roomName,
        dispatchId: dispatch.dispatchId,
        updatedAt: new Date(),
      })
      .where(eq(callLogs.jobId, jobId));
  }

  async releaseReservation(jobId: string, summary: string): Promise<void> {
    await this.markFailed(jobId, summary);
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

  /**
   * Clear verbatim transcripts older than retentionDays.
   * Keeps outcome, summary, phone, and metadata (marks purged).
   */
  async purgeExpiredTranscripts(retentionDays: number): Promise<number> {
    if (!isDatabaseEnabled() || retentionDays <= 0) return 0;

    const db = getDb();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const purgedAt = new Date().toISOString();

    const updated = await db
      .update(callLogs)
      .set({
        transcript: [],
        metadata: sql`coalesce(${callLogs.metadata}, '{}'::jsonb) || ${JSON.stringify({
          transcript_purged_at: purgedAt,
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          lt(callLogs.completedAt, cutoff),
          sql`jsonb_typeof(${callLogs.transcript}) = 'array'`,
          sql`jsonb_array_length(${callLogs.transcript}) > 0`,
        ),
      )
      .returning({ id: callLogs.id });

    return updated.length;
  }

  /** Legacy non-atomic check — prefer reserveDispatchSlot for production dispatch. */
  async findBlockingDispatch(input: {
    propertyId: string;
    phoneNumber: string;
    cooldownMs: number;
  }): Promise<CallLogRow | null> {
    if (!isDatabaseEnabled()) return null;

    const db = getDb();
    const activeRows = await db
      .select()
      .from(callLogs)
      .where(
        and(
          inArray(callLogs.status, [...ACTIVE_STATUSES]),
          or(
            and(
              eq(callLogs.propertyId, input.propertyId),
              eq(callLogs.phoneNumber, input.phoneNumber),
            ),
          ),
        ),
      )
      .limit(1);

    if (activeRows[0]) return activeRows[0];

    const cutoff = new Date(Date.now() - input.cooldownMs);
    const recentRows = await db
      .select()
      .from(callLogs)
      .where(
        and(
          gte(callLogs.createdAt, cutoff),
          eq(callLogs.propertyId, input.propertyId),
          eq(callLogs.phoneNumber, input.phoneNumber),
        ),
      )
      .limit(1);

    return recentRows[0] ?? null;
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

export async function safeFindBlockingDispatch(input: {
  propertyId: string;
  phoneNumber: string;
  cooldownMs: number;
}): Promise<CallLogRow | null> {
  try {
    return await getCallLogRepository().findBlockingDispatch(input);
  } catch (error) {
    callWarn(
      `[CALL] call_log.dedupe_fail property=${input.propertyId} phone=${input.phoneNumber} error=${error}`,
    );
    return null;
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
