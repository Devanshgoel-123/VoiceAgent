import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallLogSnapshot } from './call-log-types.js';
import type { CallResult } from './models.js';

const DEFAULT_RESULTS_DIR = 'call_results';

export function snapshotToCallResult(snapshot: CallLogSnapshot): CallResult {
  return {
    jobId: snapshot.jobId,
    status: snapshot.status,
    propertyStillAvailable:
      snapshot.ownerOutcome === 'yes' ||
      snapshot.ownerOutcome === 'no' ||
      snapshot.ownerOutcome === 'unclear'
        ? snapshot.ownerOutcome
        : snapshot.ownerOutcome === 'other'
          ? 'unclear'
          : 'not_asked',
    GalynestShouldFindTenants: 'not_asked',
    conversationLanguage: snapshot.languages[0],
    languagesUsed: snapshot.languages,
    ownerOutcome: snapshot.ownerOutcome,
    success: snapshot.success,
    answered: snapshot.answered,
    transcript: snapshot.transcript,
    transcriptSummary: snapshot.transcriptSummary,
    rawMetadata: snapshot.metadata,
    completedAt: snapshot.completedAt,
  };
}

export async function saveCallResultSnapshot(
  snapshot: CallLogSnapshot,
  resultsDir = DEFAULT_RESULTS_DIR,
): Promise<string> {
  await mkdir(resultsDir, { recursive: true });
  const path = join(resultsDir, `${snapshot.jobId}.json`);
  await writeFile(path, JSON.stringify(snapshotToCallResult(snapshot), null, 2), 'utf-8');
  return path;
}
