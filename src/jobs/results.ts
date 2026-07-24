import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallResult } from './models.js';

const DEFAULT_RESULTS_DIR = 'call_results';

export class CallResultStore {
  private readonly dir: string;

  constructor(resultsDir = DEFAULT_RESULTS_DIR) {
    this.dir = resultsDir;
  }

  async save(result: CallResult): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${result.jobId}.json`);
    // Never persist verbatim transcripts on disk — DB is the sole transcript store.
    const { transcript: _transcript, ...safe } = result;
    await writeFile(path, JSON.stringify(safe, null, 2), 'utf-8');
    return path;
  }

  async load(jobId: string): Promise<CallResult | null> {
    try {
      const path = join(this.dir, `${jobId}.json`);
      const raw = await readFile(path, 'utf-8');
      return JSON.parse(raw) as CallResult;
    } catch {
      return null;
    }
  }

  async listResults(): Promise<CallResult[]> {
    try {
      await mkdir(this.dir, { recursive: true });
      const files = await readdir(this.dir);
      const results: CallResult[] = [];

      for (const file of files.filter((f) => f.endsWith('.json'))) {
        try {
          const raw = await readFile(join(this.dir, file), 'utf-8');
          results.push(JSON.parse(raw) as CallResult);
        } catch {
          // skip corrupt files
        }
      }

      return results.sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''));
    } catch {
      return [];
    }
  }
}
