import type { Settings } from '../config/settings.js';
import type { CallPreferenceRow } from '../db/schema.js';

export type ComplianceBlockReason =
  | 'outside_calling_hours'
  | 'dnd'
  | 'opted_out'
  | 'suppressed'
  | 'database_required';

export interface ComplianceDecision {
  allowed: boolean;
  reason?: ComplianceBlockReason;
  detail?: string;
}

/** Wall-clock hour (0–23) in the configured calling-hours timezone. */
export function currentHourInTimeZone(
  timeZone: string,
  now: Date = new Date(),
): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  // Some environments report 24 for midnight — normalize.
  return hour === 24 ? 0 : hour;
}

export function isWithinCallingHours(
  settings: Pick<
    Settings,
    'callingHoursStartHour' | 'callingHoursEndHour' | 'callingHoursTimeZone'
  >,
  now: Date = new Date(),
): boolean {
  const hour = currentHourInTimeZone(settings.callingHoursTimeZone, now);
  const start = settings.callingHoursStartHour;
  const end = settings.callingHoursEndHour;
  if (start === end) return true;
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Overnight window (e.g. 22 → 6)
  return hour >= start || hour < end;
}

export function evaluateCallPreferences(
  preference: CallPreferenceRow | null,
  isSuppressed: boolean,
): ComplianceDecision {
  if (isSuppressed) {
    return {
      allowed: false,
      reason: 'suppressed',
      detail: 'Phone number is on the do-not-call / suppression list',
    };
  }

  if (preference?.optedOutAt) {
    return {
      allowed: false,
      reason: 'opted_out',
      detail: preference.optOutReason ?? 'Owner explicitly opted out',
    };
  }

  if (preference?.dnd) {
    return {
      allowed: false,
      reason: 'dnd',
      detail: 'Phone number is marked DND',
    };
  }

  // Compatible policy: consent is optional — unknown/granted both allow.
  return { allowed: true };
}

export function evaluateDispatchCompliance(input: {
  settings: Settings;
  preference: CallPreferenceRow | null;
  isSuppressed: boolean;
  now?: Date;
}): ComplianceDecision {
  if (!isWithinCallingHours(input.settings, input.now)) {
    return {
      allowed: false,
      reason: 'outside_calling_hours',
      detail: `Calls are only allowed between ${input.settings.callingHoursStartHour}:00 and ${input.settings.callingHoursEndHour}:00 ${input.settings.callingHoursTimeZone}`,
    };
  }

  return evaluateCallPreferences(input.preference, input.isSuppressed);
}
