#!/usr/bin/env node
import 'dotenv/config';
import { getSettings } from '../config/settings.js';
import { runVoiceCron } from '../jobs/voice-cron.js';

async function main() {
  const settings = getSettings();
  const summary = await runVoiceCron(settings);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0 && summary.dispatched === 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Voice cron failed:', error);
  process.exit(1);
});
