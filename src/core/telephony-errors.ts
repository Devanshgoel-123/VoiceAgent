/** Typed error for SIP no-answer / mic-timeout — do not rely on message substring matching. */
export class NoAnswerError extends Error {
  readonly code = 'NO_ANSWER' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoAnswerError';
  }
}

export function isNoAnswerError(error: unknown): boolean {
  return error instanceof NoAnswerError;
}
