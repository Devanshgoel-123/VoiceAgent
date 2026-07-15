import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallResult, YesNoAnswer } from './models.js';

const DEFAULT_RESULTS_DIR = 'call_results';

export class CallResultStore {
  private readonly dir: string;

  constructor(resultsDir = DEFAULT_RESULTS_DIR) {
    this.dir = resultsDir;
  }

  async save(result: CallResult): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${result.jobId}.json`);
    await writeFile(path, JSON.stringify(result, null, 2), 'utf-8');
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

export function buildCallResult(params: {
  jobId: string;
  propertyAvailable: YesNoAnswer;
  findTenants?: YesNoAnswer;
  language?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}): CallResult {
  return {
    jobId: params.jobId,
    status: 'completed',
    propertyStillAvailable: params.propertyAvailable,
    GalynestShouldFindTenants: params.findTenants ?? 'not_asked',
    conversationLanguage: params.language,
    transcriptSummary: params.summary,
    rawMetadata: params.metadata ?? {},
    completedAt: new Date().toISOString(),
  };
}
