#!/usr/bin/env node
import 'dotenv/config';
import { getSettings } from '../config/settings.js';
import { registerProcessSafetyHandlers } from '../core/process-safety.js';
import { closeDb } from '../db/client.js';
import { runVoiceCronTick, startVoiceCronLoop } from '../jobs/voice-cron.js';

/** Reads `--flag=value` or `--flag value` from argv. */
function parseFlagValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    if (arg === flag) return argv[i + 1];
  }
  return undefined;
}

/** Reads `--max-properties=<n>` or `--max-properties <n>` from CLI args. */
export function parseMaxProperties(argv: string[]): number | undefined {
  const raw = parseFlagValue(argv, '--max-properties');
  if (raw === undefined) return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--max-properties must be a positive integer, got "${raw}"`);
  }
  return value;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a `YYYY-MM-DD` date (always IST) into the UTC instant of that day's IST midnight. */
function istDateOnlyToUtcIso(flag: string, raw: string): string {
  const match = YMD_PATTERN.exec(raw);
  if (!match) {
    throw new Error(`${flag} must be a date in YYYY-MM-DD format (IST), got "${raw}"`);
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  const midnightUtcMs = Date.UTC(year, month - 1, day);
  const check = new Date(midnightUtcMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`${flag} is not a real calendar date: "${raw}"`);
  }

  return new Date(midnightUtcMs - IST_OFFSET_MS).toISOString();
}

/**
 * Reads `--created-after=YYYY-MM-DD` and `--created-before=YYYY-MM-DD` — both
 * required, always interpreted as IST calendar dates (not ISO datetimes).
 * `createdAfter` is that day's IST midnight (inclusive); `createdBefore` is
 * that day's IST midnight as a strict upper bound (exclusive of that day),
 * matching this codebase's existing `contactedBefore` cutoff convention.
 */
export function parseListingDateRange(argv: string[]): {
  createdAfter: string;
  createdBefore: string;
} {
  const createdAfterRaw = parseFlagValue(argv, '--created-after');
  const createdBeforeRaw = parseFlagValue(argv, '--created-before');

  if (!createdAfterRaw || !createdBeforeRaw) {
    throw new Error(
      '--created-after and --created-before are both required (YYYY-MM-DD, IST). ' +
        '--created-after is inclusive of that date; --created-before is exclusive of that ' +
        'date (properties must be created before it, not on it). ' +
        'e.g. --created-after=2026-07-01 --created-before=2026-07-15 includes properties ' +
        'listed Jul 1 through Jul 14 IST.',
    );
  }

  const createdAfter = istDateOnlyToUtcIso('--created-after', createdAfterRaw);
  const createdBefore = istDateOnlyToUtcIso('--created-before', createdBeforeRaw);

  if (Date.parse(createdAfter) >= Date.parse(createdBefore)) {
    throw new Error('--created-after must be earlier than --created-before');
  }

  return { createdAfter, createdBefore };
}

async function main() {
  registerProcessSafetyHandlers('api');
  const settings = getSettings();
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const dryRun = args.includes('--dry-run');
  const maxProperties = parseMaxProperties(args);
  const { createdAfter, createdBefore } = parseListingDateRange(args);

  if (once) {
    try {
      const summary = await runVoiceCronTick(settings, {
        maxProperties,
        dryRun,
        createdAfter,
        createdBefore,
      });
      console.log(JSON.stringify({ tickAt: new Date().toISOString(), ...summary }, null, 2));
      if (summary.failed > 0 && summary.dispatched === 0 && summary.wouldDispatch === 0) {
        process.exitCode = 1;
      }
    } finally {
      // Dispatching (or a dry-run suppression check) opens a pooled Postgres
      // connection with no idle_timeout — without this the process never
      // exits on its own after a --once run.
      await closeDb();
    }
    return;
  }

  console.log(
    `Voice cron started (interval=${settings.voiceCronIntervalMs}ms` +
      `, createdAfter=${createdAfter}, createdBefore=${createdBefore}` +
      (maxProperties ? `, maxProperties=${maxProperties}` : '') +
      (dryRun ? ', dryRun=true' : '') +
      `). Use --once for a single tick.`,
  );
  startVoiceCronLoop(settings, { maxProperties, dryRun, createdAfter, createdBefore });

  const shutdown = () => {
    console.log('Voice cron stopping…');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((error) => {
    console.error('Voice cron failed:', error);
    process.exit(1);
  });
}
