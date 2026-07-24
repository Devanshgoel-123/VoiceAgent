import type { CallMetadata } from '../core/types.js';
import type {
  CallDirection,
  CallLogSnapshot,
  OwnerOutcome,
} from './call-log-types.js';
import { isSuccessfulOutcome } from './call-log-types.js';
import type { CallJobStatus } from './models.js';
import { CallTranscriptBuilder, summarizeUnclearCall } from './transcript.js';

interface SessionReportLike {
  chatHistory?: {
    toJSON: (options?: { excludeTimestamp?: boolean }) => unknown;
  };
}

export class CallSessionRecord {
  readonly jobId: string;
  readonly metadata: CallMetadata;
  readonly transcriptBuilder = new CallTranscriptBuilder();
  readonly direction: CallDirection = 'outbound';

  private status: CallJobStatus = 'dispatched';
  private ownerOutcome: OwnerOutcome = 'not_asked';
  private summary?: string;
  private answered = false;
  private startedAt?: string;
  private roomName?: string;
  private dispatchId?: string;
  private doNotCallReason?: string;

  constructor(metadata: CallMetadata) {
    this.jobId = String(metadata.job_id ?? 'unknown');
    this.metadata = metadata;
    this.roomName = metadata.room_name as string | undefined;
    this.dispatchId = metadata.dispatch_id as string | undefined;
    this.transcriptBuilder.addLanguage(
      (metadata.preferred_language as string | undefined) ?? undefined,
    );
  }

  markInProgress(): void {
    this.status = 'in_progress';
    this.startedAt = new Date().toISOString();
  }

  markAnswered(): void {
    this.answered = true;
  }

  markNoAnswer(summary: string): void {
    this.status = 'no_answer';
    this.ownerOutcome = 'other';
    this.summary = summary;
    this.answered = false;
  }

  markFailed(summary: string): void {
    this.status = 'failed';
    this.ownerOutcome = 'other';
    this.summary = summary;
  }

  recordOwnerOutcome(outcome: OwnerOutcome, summary: string): void {
    this.ownerOutcome = outcome;
    this.summary = summary;
  }

  recordDoNotCall(reason: string): void {
    this.doNotCallReason = reason;
  }

  finalize(report?: SessionReportLike | null): CallLogSnapshot {
    const transcript = this.transcriptBuilder.mergeSessionReport(report ?? null);
    const languages = this.transcriptBuilder.getLanguages();

    let ownerOutcome = this.ownerOutcome;
    let summary = this.summary;
    let status = this.status;

    if (status === 'in_progress' || status === 'dispatched') {
      status = 'completed';
    }

    if (ownerOutcome === 'not_asked' || ownerOutcome === 'unclear') {
      ownerOutcome = 'other';
      summary = summary ?? summarizeUnclearCall(transcript);
    }

    const success = status === 'completed' && isSuccessfulOutcome(ownerOutcome);

    return {
      jobId: this.jobId,
      direction: this.direction,
      status,
      ownerOutcome,
      success,
      answered: this.answered,
      phoneNumber: this.metadata.phone_number as string | undefined,
      ownerName: this.metadata.owner_name as string | undefined,
      propertyId: this.metadata.property_id as string | undefined,
      propertyAddress: this.metadata.property_address as string | undefined,
      callerName: this.metadata.caller_name as string | undefined,
      companyName: this.metadata.company_name as string | undefined,
      roomName: this.roomName,
      dispatchId: this.dispatchId,
      languages,
      transcript,
      transcriptSummary: summary,
      metadata: {
        ...this.metadata,
        ...(this.doNotCallReason
          ? { do_not_call: true, do_not_call_reason: this.doNotCallReason }
          : {}),
      },
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}
