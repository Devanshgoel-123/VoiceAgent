import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  purgeExpiredCallResultFiles,
  saveCallResultSnapshot,
} from '../src/jobs/persist-call-result.js';
import type { CallLogSnapshot } from '../src/jobs/call-log-types.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sampleSnapshot(): CallLogSnapshot {
  return {
    jobId: 'job-retention-1',
    direction: 'outbound',
    status: 'completed',
    ownerOutcome: 'yes',
    success: true,
    answered: true,
    phoneNumber: '+919876543210',
    ownerName: 'Ramesh',
    languages: ['en-IN'],
    transcript: [
      {
        role: 'user',
        text: 'yes available',
        timestamp: new Date().toISOString(),
        isFinal: true,
      },
    ],
    transcriptSummary: 'Owner confirmed available.',
    metadata: { job_type: 'property_availability' },
    completedAt: new Date().toISOString(),
  };
}

describe('call result disk snapshots', () => {
  it('never writes verbatim transcripts to JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'call-results-'));
    dirs.push(dir);

    const path = await saveCallResultSnapshot(sampleSnapshot(), dir);
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;

    expect(raw.transcript).toBeUndefined();
    expect(raw.transcriptSummary).toBe('Owner confirmed available.');
    expect(raw.ownerOutcome).toBe('yes');
    expect((raw.rawMetadata as { transcript_storage?: string }).transcript_storage).toBe(
      'database_only',
    );
  });

  it('deletes aged JSON files during file retention purge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'call-results-'));
    dirs.push(dir);

    const oldPath = join(dir, 'old.json');
    const newPath = join(dir, 'new.json');
    await writeFile(oldPath, '{}', 'utf-8');
    await writeFile(newPath, '{}', 'utf-8');

    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    await utimes(oldPath, sixteenDaysAgo, sixteenDaysAgo);

    const removed = await purgeExpiredCallResultFiles(15, dir);
    expect(removed).toBe(1);

    await expect(readFile(oldPath, 'utf-8')).rejects.toThrow();
    await expect(readFile(newPath, 'utf-8')).resolves.toBe('{}');
  });
});
