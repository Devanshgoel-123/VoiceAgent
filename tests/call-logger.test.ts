import { afterEach, describe, expect, it } from 'vitest';
import {
  isCallDebugEnabled,
  isDeveloperEnv,
} from '../src/core/call-logger.js';

describe('call logging flags', () => {
  const originalEnv = process.env.APP_ENV;
  const originalDebug = process.env.CALL_DEBUG_LOGGING;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalEnv;
    if (originalDebug === undefined) delete process.env.CALL_DEBUG_LOGGING;
    else process.env.CALL_DEBUG_LOGGING = originalDebug;
  });

  it('defaults to developer with debug on', () => {
    delete process.env.APP_ENV;
    delete process.env.CALL_DEBUG_LOGGING;
    expect(isDeveloperEnv()).toBe(true);
    expect(isCallDebugEnabled()).toBe(true);
  });

  it('disables stage logs in production', () => {
    process.env.APP_ENV = 'production';
    delete process.env.CALL_DEBUG_LOGGING;
    expect(isDeveloperEnv()).toBe(false);
    expect(isCallDebugEnabled()).toBe(false);
  });

  it('allows CALL_DEBUG_LOGGING override in production', () => {
    process.env.APP_ENV = 'production';
    process.env.CALL_DEBUG_LOGGING = 'true';
    expect(isCallDebugEnabled()).toBe(true);
  });
});
