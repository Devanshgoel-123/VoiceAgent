#!/usr/bin/env node
import 'dotenv/config';
import { getSettings } from '../config/settings.js';
import { registerProcessSafetyHandlers } from '../core/process-safety.js';
import { runVoiceCronTick, startVoiceCronLoop } from '../jobs/voice-cron.js';

async function main() {
  registerProcessSafetyHandlers('api');
  const settings = getSettings();
  const once = process.argv.includes('--once');

  if (once) {
    const summary = await runVoiceCronTick(settings);
    console.log(JSON.stringify({ tickAt: new Date().toISOString(), ...summary }, null, 2));
    if (summary.failed > 0 && summary.dispatched === 0) {
      process.exitCode = 1;
    }
    return;
  }

  console.log(
    `Voice cron started (interval=${settings.voiceCronIntervalMs}ms). Use --once for a single tick.`,
  );
  startVoiceCronLoop(settings);

  const shutdown = () => {
    console.log('Voice cron stopping…');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Voice cron failed:', error);
  process.exit(1);
});
