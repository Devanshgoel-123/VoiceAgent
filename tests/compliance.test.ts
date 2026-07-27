import { describe, expect, it } from 'vitest';
import {
  evaluateCallSuppression,
  evaluateDispatchCompliance,
  isWithinCallingHours,
} from '../src/jobs/compliance.js';
import type { Settings } from '../src/config/settings.js';

function settings(): Pick<
  Settings,
  | 'callingHoursStartHour'
  | 'callingHoursEndHour'
  | 'callingHoursTimeZone'
  | 'dispatchCooldownMs'
> &
  Settings {
  return {
    livekitUrl: 'wss://example.livekit.cloud',
    livekitApiKey: 'key',
    livekitApiSecret: 'secret',
    sarvamApiKey: 'sarvam',
    ttsProvider: 'sarvam',
    elevenLabsModel: 'eleven_v3',
    elevenLabsTransport: 'http',
    ttsVolume: 0.65,
    ttsSpeed: 0.8,
    sipOutboundTrunkId: 'ST_test',
    agentName: 'test-agent',
    apiHost: '127.0.0.1',
    apiPort: 8080,
    apiSecretKey: 'test-secret',
    companyName: 'Galynest',
    companyWebsite: 'galynest.com',
    callerName: 'Aditi',
    llmModel: 'sarvam-105b',
    defaultLanguage: 'en-IN',
    telephonySampleRate: 8000,
    dispatchCooldownMs: 86_400_000,
    callingHoursStartHour: 9,
    callingHoursEndHour: 20,
    callingHoursTimeZone: 'Asia/Kolkata',
    callDataRetentionDays: 15,
    apiReadRateLimitPerMinute: 60,
    voiceCronIntervalMs: 900_000,
    appEnv: 'developer',
    callDebugLogging: false,
  };
}

describe('calling hours', () => {
  it('allows calls inside the IST window', () => {
    // 2026-07-24 12:00 IST = 06:30 UTC
    const noonIst = new Date('2026-07-24T06:30:00.000Z');
    expect(isWithinCallingHours(settings(), noonIst)).toBe(true);
  });

  it('blocks calls outside the IST window', () => {
    // 2026-07-24 21:00 IST = 15:30 UTC
    const eveningIst = new Date('2026-07-24T15:30:00.000Z');
    expect(isWithinCallingHours(settings(), eveningIst)).toBe(false);
  });
});

describe('suppression compliance', () => {
  it('allows calls when not suppressed', () => {
    expect(evaluateCallSuppression(false).allowed).toBe(true);
  });

  it('blocks suppressed numbers', () => {
    const decision = evaluateCallSuppression(true);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('suppressed');
  });

  it('combines quiet hours with suppression', () => {
    const eveningIst = new Date('2026-07-24T15:30:00.000Z');
    const decision = evaluateDispatchCompliance({
      settings: settings(),
      isSuppressed: false,
      now: eveningIst,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside_calling_hours');
  });
});
