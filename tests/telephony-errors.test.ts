import { describe, expect, it } from 'vitest';
import { isNoAnswerError, NoAnswerError } from '../src/core/telephony-errors.js';

describe('NoAnswerError', () => {
  it('is detected by isNoAnswerError', () => {
    const error = new NoAnswerError('Timed out waiting for microphone track from owner-1');
    expect(isNoAnswerError(error)).toBe(true);
    expect(error.code).toBe('NO_ANSWER');
  });

  it('does not match generic errors', () => {
    expect(isNoAnswerError(new Error('Timed out waiting for microphone'))).toBe(false);
  });
});
