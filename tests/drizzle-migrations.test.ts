import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('drizzle migration journal', () => {
  it('lists every committed SQL migration file', async () => {
    const drizzleDir = join(process.cwd(), 'drizzle');
    const sqlFiles = (await readdir(drizzleDir))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.replace(/\.sql$/, ''))
      .sort();

    const journal = JSON.parse(
      await readFile(join(drizzleDir, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };

    const journalTags = journal.entries.map((entry) => entry.tag).sort();
    expect(journalTags).toEqual(sqlFiles);
  });

  it('has a snapshot for the latest migration', async () => {
    const drizzleDir = join(process.cwd(), 'drizzle');
    const journal = JSON.parse(
      await readFile(join(drizzleDir, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };

    const latest = journal.entries.at(-1);
    expect(latest).toBeTruthy();

    const snapshotPath = join(
      drizzleDir,
      'meta',
      `${String(latest!.idx).padStart(4, '0')}_snapshot.json`,
    );
    await expect(readFile(snapshotPath, 'utf8')).resolves.toBeTypeOf('string');
  });
});
