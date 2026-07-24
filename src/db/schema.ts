import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { OwnerOutcome, TranscriptEntry } from '../jobs/call-log-types.js';
import type { CallJobStatus } from '../jobs/models.js';

export type ConsentStatus = 'unknown' | 'granted' | 'denied';

/**
 * Call log rows. A partial unique index on (property_id, phone_number) for
 * active statuses is defined in the SQL migration (not expressible cleanly here).
 */
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

/** Owners who declined or opted out — checked before every dispatch. */
export const suppressedNumbers = pgTable(
  'suppressed_numbers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    phoneNumber: text('phone_number').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    phoneUnique: uniqueIndex('suppressed_numbers_phone_unique').on(table.phoneNumber),
  }),
);

/** Consent / DND / explicit opt-out preferences keyed by phone number. */
export const callPreferences = pgTable(
  'call_preferences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    phoneNumber: text('phone_number').notNull(),
    consentStatus: text('consent_status')
      .notNull()
      .$type<ConsentStatus>()
      .default('unknown'),
    consentSource: text('consent_source'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    dnd: boolean('dnd').notNull().default(false),
    dndSource: text('dnd_source'),
    dndAt: timestamp('dnd_at', { withTimezone: true }),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    optOutReason: text('opt_out_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    phoneUnique: uniqueIndex('call_preferences_phone_unique').on(table.phoneNumber),
  }),
);

export type CallLogRow = typeof callLogs.$inferSelect;
export type NewCallLogRow = typeof callLogs.$inferInsert;
export type SuppressedNumberRow = typeof suppressedNumbers.$inferSelect;
export type CallPreferenceRow = typeof callPreferences.$inferSelect;
