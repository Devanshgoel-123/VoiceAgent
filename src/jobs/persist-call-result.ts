import { mkdir, readdir, unlink, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallLogSnapshot } from './call-log-types.js';
import type { CallResult } from './models.js';

const DEFAULT_RESULTS_DIR = 'call_results';

/**
 * Disk snapshots intentionally omit verbatim transcripts.
 * Full transcripts live only in Postgres until retention purge.
 */
function snapshotToCallResult(snapshot: CallLogSnapshot): CallResult {
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
    conversationLanguage: snapshot.languages[0],
    languagesUsed: snapshot.languages,
    ownerOutcome: snapshot.ownerOutcome,
    success: snapshot.success,
    answered: snapshot.answered,
    transcriptSummary: snapshot.transcriptSummary,
    rawMetadata: {
      ...snapshot.metadata,
      transcript_storage: 'database_only',
    },
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

/** Delete local call_results/*.json older than retentionDays (by mtime). */
export async function purgeExpiredCallResultFiles(
  retentionDays: number,
  resultsDir = DEFAULT_RESULTS_DIR,
): Promise<number> {
  if (retentionDays <= 0) return 0;

  try {
    await mkdir(resultsDir, { recursive: true });
    const files = await readdir(resultsDir);
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const file of files.filter((name) => name.endsWith('.json'))) {
      const path = join(resultsDir, file);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoffMs) {
          await unlink(path);
          removed += 1;
        }
      } catch {
        // skip unreadable files
      }
    }

    return removed;
  } catch {
    return 0;
  }
}
