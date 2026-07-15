import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { OwnerOutcome, TranscriptEntry } from '../jobs/call-log-types.js';
import type { CallJobStatus } from '../jobs/models.js';

export const callLogs = pgTable('call_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: text('job_id').notNull().unique(),
  direction: text('direction').notNull().default('outbound'),
  status: text('status').notNull().$type<CallJobStatus>().default('dispatched'),
  ownerOutcome: text('owner_outcome')
    .notNull()
    .$type<OwnerOutcome>()
    .default('not_asked'),
  success: boolean('success').notNull().default(false),
  answered: boolean('answered').notNull().default(false),
  phoneNumber: text('phone_number'),
  ownerName: text('owner_name'),
  propertyId: text('property_id'),
  propertyAddress: text('property_address'),
  callerName: text('caller_name'),
  companyName: text('company_name'),
  roomName: text('room_name'),
  dispatchId: text('dispatch_id'),
  languages: jsonb('languages').$type<string[]>().notNull(),
  transcript: jsonb('transcript').$type<TranscriptEntry[]>().notNull(),
  transcriptSummary: text('transcript_summary'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type CallLogRow = typeof callLogs.$inferSelect;
export type NewCallLogRow = typeof callLogs.$inferInsert;
