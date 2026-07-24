#!/usr/bin/env node
/**
 * Purge verbatim call transcripts older than CALL_DATA_RETENTION_DAYS (default 15)
 * and delete aged call_results/*.json files.
 *
 * Usage: npm run db:purge-expired
 */
import 'dotenv/config';
import { getSettings } from '../config/settings.js';
import { purgeExpiredCallData } from '../jobs/retention.js';

async function main() {
  const settings = getSettings();
  const result = await purgeExpiredCallData(settings.callDataRetentionDays);
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => {
  console.log('Purge completed successfully');
  process.exit(0);
}).catch((error) => {
  console.error('Purge failed:', error);
  process.exit(1);
});
