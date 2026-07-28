#!/usr/bin/env node
import 'dotenv/config';
import { getSettings } from '../config/settings.js';
import { registerProcessSafetyHandlers } from '../core/process-safety.js';
import { closeDb } from '../db/client.js';
import { runVoiceCronTick, startVoiceCronLoop } from '../jobs/voice-cron.js';

/** Reads `--max-properties=<n>` or `--max-properties <n>` from CLI args. */
export function parseMaxProperties(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let raw: string | undefined;

    if (arg?.startsWith('--max-properties=')) {
      raw = arg.slice('--max-properties='.length);
    } else if (arg === '--max-properties') {
      raw = argv[i + 1];
    }

    if (raw !== undefined) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--max-properties must be a positive integer, got "${raw}"`);
      }
      return value;
    }
  }
  return undefined;
}

async function main() {
  registerProcessSafetyHandlers('api');
  const settings = getSettings();
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const maxProperties = parseMaxProperties(args);

  if (once) {
    try {
      const summary = await runVoiceCronTick(settings, { maxProperties });
      console.log(JSON.stringify({ tickAt: new Date().toISOString(), ...summary }, null, 2));
      if (summary.failed > 0 && summary.dispatched === 0) {
        process.exitCode = 1;
      }
    } finally {
      // Dispatching opens a pooled Postgres connection with no idle_timeout —
      // without this the process never exits on its own after a --once run.
      await closeDb();
    }
    return;
  }

  console.log(
    `Voice cron started (interval=${settings.voiceCronIntervalMs}ms` +
      (maxProperties ? `, maxProperties=${maxProperties}` : '') +
      `). Use --once for a single tick.`,
  );
  startVoiceCronLoop(settings, { maxProperties });

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
