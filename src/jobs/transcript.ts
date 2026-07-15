import type { TranscriptEntry } from './call-log-types.js';

interface SessionReportLike {
  chatHistory?: {
    toJSON: (options?: { excludeTimestamp?: boolean }) => unknown;
  };
}

/** In-memory transcript + language collector for one call. */
export class CallTranscriptBuilder {
  private readonly entries: TranscriptEntry[] = [];
  private readonly languages = new Set<string>();

  addLanguage(language: string | null | undefined): void {
    const normalized = language?.trim();
    if (normalized && normalized !== 'unknown') {
      this.languages.add(normalized);
    }
  }

  addUserTranscript(
    text: string,
    options: { isFinal?: boolean; language?: string | null; source?: string } = {},
  ): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.addLanguage(options.language ?? undefined);
    this.pushIfNew({
      role: 'user',
      text: trimmed,
      language: options.language ?? undefined,
      isFinal: options.isFinal,
      timestamp: new Date().toISOString(),
      source: options.source ?? 'stt',
    });
  }

  addAssistantText(text: string, source = 'agent'): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.pushIfNew({
      role: 'assistant',
      text: trimmed,
      timestamp: new Date().toISOString(),
      source,
    });
  }

  getLanguages(): string[] {
    return [...this.languages];
  }

  getEntries(): TranscriptEntry[] {
    return [...this.entries];
  }

  /** Merge LiveKit session chat history without duplicating identical adjacent lines. */
  mergeSessionReport(report: SessionReportLike | null | undefined): TranscriptEntry[] {
    if (!report?.chatHistory) {
      return this.getEntries();
    }

    try {
      const raw = report.chatHistory.toJSON({ excludeTimestamp: false }) as unknown;
      const items = Array.isArray(raw) ? raw : [];
      for (const item of items) {
        const entry = chatItemToTranscriptEntry(item);
        if (entry) {
          this.pushIfNew(entry);
        }
      }
    } catch {
      // Keep manually collected entries only.
    }

    return this.getEntries();
  }

  private pushIfNew(entry: TranscriptEntry): void {
    const last = this.entries.at(-1);
    if (last && last.role === entry.role && last.text === entry.text) {
      return;
    }
    this.entries.push(entry);
  }
}

function chatItemToTranscriptEntry(item: unknown): TranscriptEntry | null {
  if (!item || typeof item !== 'object') return null;

  const record = item as Record<string, unknown>;
  const type = String(record.type ?? '');
  const createdAt =
    typeof record.createdAt === 'number'
      ? new Date(record.createdAt).toISOString()
      : new Date().toISOString();

  if (type === 'message') {
    const role = String(record.role ?? 'assistant');
    const text = extractMessageText(record);
    if (!text) return null;
    return {
      role: role === 'user' ? 'user' : role === 'system' ? 'system' : 'assistant',
      text,
      timestamp: createdAt,
      source: 'chat_history',
      isFinal: true,
    };
  }

  if (type === 'function_call_output') {
    const text = String(record.output ?? record.content ?? '').trim();
    if (!text) return null;
    return {
      role: 'tool',
      text,
      timestamp: createdAt,
      source: 'tool_output',
      isFinal: true,
    };
  }

  return null;
}

function extractMessageText(record: Record<string, unknown>): string {
  const content = record.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (part && typeof part === 'object') {
      const obj = part as Record<string, unknown>;
      if (typeof obj.text === 'string') parts.push(obj.text);
      else if (typeof obj.transcript === 'string') parts.push(obj.transcript);
    }
  }
  return parts.join(' ').trim();
}

export function summarizeUnclearCall(transcript: TranscriptEntry[]): string {
  const ownerLines = transcript
    .filter((entry) => entry.role === 'user' && entry.isFinal !== false)
    .map((entry) => entry.text.trim())
    .filter(Boolean);

  if (!ownerLines.length) {
    return 'Call ended without a clear owner response.';
  }

  const tail = ownerLines.slice(-3).join(' | ');
  return `Owner did not give a clear yes/no. Recent owner speech: "${tail}"`;
}
