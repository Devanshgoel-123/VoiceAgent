import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReserveDispatchError } from '../src/db/call-log-repository.js';
import { createPropertyAvailabilityJob } from '../src/jobs/models.js';
import type { Settings } from '../src/config/settings.js';

const settings = (): Settings => ({
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
  callingHoursStartHour: 0,
  callingHoursEndHour: 24,
  callingHoursTimeZone: 'UTC',
  callDataRetentionDays: 15,
  apiReadRateLimitPerMinute: 60,
  voiceCronIntervalMs: 900_000,
  appEnv: 'developer',
  callDebugLogging: false,
  databaseUrl: 'postgresql://example',
});

describe('secureDispatchPropertyAvailabilityCall', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns conflict when reservation is already held', async () => {
    const reserveDispatchSlot = vi.fn(async () => {
      throw new ReserveDispatchError('conflict_active', 'already active', {
        jobId: 'job-existing',
        status: 'in_progress',
      } as never);
    });

    vi.doMock('../src/db/call-log-repository.js', () => ({
      isDatabaseEnabled: () => true,
      ReserveDispatchError,
      getCallLogRepository: () => ({
        reserveDispatchSlot,
        attachDispatch: vi.fn(),
        releaseReservation: vi.fn(),
      }),
    }));

    const { secureDispatchPropertyAvailabilityCall } = await import(
      '../src/jobs/dispatch-pipeline.js'
    );

    const job = createPropertyAvailabilityJob({
      owner: { name: 'Ramesh', phoneNumber: '+919876543210' },
      property: { propertyId: 'P1', address: '42 Indiranagar' },
    });

    const dispatcher = {
      dispatchPropertyAvailabilityCall: vi.fn(),
    };

    const outcome = await secureDispatchPropertyAvailabilityCall(
      job,
      settings(),
      dispatcher as never,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('conflict');
      expect(outcome.failure.status).toBe(409);
    }
    expect(dispatcher.dispatchPropertyAvailabilityCall).not.toHaveBeenCalled();
  });

  it('attaches dispatch metadata after a successful LiveKit create', async () => {
    const attachDispatch = vi.fn(async () => undefined);
    const reserveDispatchSlot = vi.fn(async () => ({ jobId: 'job-1' }));

    vi.doMock('../src/db/call-log-repository.js', () => ({
      isDatabaseEnabled: () => true,
      ReserveDispatchError,
      getCallLogRepository: () => ({
        reserveDispatchSlot,
        attachDispatch,
        releaseReservation: vi.fn(),
      }),
    }));

    const { secureDispatchPropertyAvailabilityCall } = await import(
      '../src/jobs/dispatch-pipeline.js'
    );

    const job = createPropertyAvailabilityJob({
      jobId: 'job-1',
      owner: { name: 'Ramesh', phoneNumber: '+919876543210' },
      property: { propertyId: 'P1', address: '42 Indiranagar' },
    });

    const dispatcher = {
      dispatchPropertyAvailabilityCall: vi.fn(async () => ({
        jobId: 'job-1',
        status: 'dispatched' as const,
        roomName: 'room-1',
        dispatchId: 'dispatch-1',
        agentName: 'test-agent',
        phoneNumber: '+919876543210',
      })),
    };

    const outcome = await secureDispatchPropertyAvailabilityCall(
      job,
      settings(),
      dispatcher as never,
    );
    expect(outcome.ok).toBe(true);
    expect(attachDispatch).toHaveBeenCalledWith('job-1', {
      roomName: 'room-1',
      dispatchId: 'dispatch-1',
    });
  });
});
