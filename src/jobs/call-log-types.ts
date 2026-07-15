import type { CallJobStatus, YesNoAnswer } from './models.js';

export type CallDirection = 'outbound' | 'inbound';

/** Owner availability answer, or "other" when unclear / not captured. */
export type OwnerOutcome = YesNoAnswer | 'other';

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  language?: string;
  isFinal?: boolean;
  timestamp: string;
  source?: string;
}

export interface CallLogSnapshot {
  jobId: string;
  direction: CallDirection;
  status: CallJobStatus;
  ownerOutcome: OwnerOutcome;
  success: boolean;
  answered: boolean;
  phoneNumber?: string;
  ownerName?: string;
  propertyId?: string;
  propertyAddress?: string;
  callerName?: string;
  companyName?: string;
  roomName?: string;
  dispatchId?: string;
  languages: string[];
  transcript: TranscriptEntry[];
  transcriptSummary?: string;
  metadata: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
}

export function isSuccessfulOutcome(outcome: OwnerOutcome): boolean {
  return outcome === 'yes' || outcome === 'no';
}
