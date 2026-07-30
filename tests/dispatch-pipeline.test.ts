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
  dispatchCooldownMs: 7 * 24 * 60 * 60 * 1000,
  callingHoursStartHour: 0,
  callingHoursEndHour: 24,
  callingHoursTimeZone: 'UTC',
  callDataRetentionDays: 15,
  apiReadRateLimitPerMinute: 60,
  apiSuppressionWriteRateLimitPerMinute: 10,
  voiceCronIntervalMs: 900_000,
  appEnv: 'developer',
  callDebugLogging: false,
  databaseUrl: 'postgresql://example',
});

const settingsWithGullyNest = (): Settings => ({
  ...settings(),
  voiceAgentApiBaseUrl: 'https://example.com',
  voiceAgentApiSecret: 'secret-123',
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
        isPhoneSuppressed: vi.fn(async () => false),
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
        isPhoneSuppressed: vi.fn(async () => false),
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

  it('blocks dispatch when phone is suppressed', async () => {
    const reserveDispatchSlot = vi.fn(async () => ({ jobId: 'job-1' }));

    vi.doMock('../src/db/call-log-repository.js', () => ({
      isDatabaseEnabled: () => true,
      ReserveDispatchError,
      getCallLogRepository: () => ({
        isPhoneSuppressed: vi.fn(async () => true),
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
      expect(outcome.failure.kind).toBe('compliance');
      expect(outcome.failure.status).toBe(403);
      expect(outcome.failure.reason).toBe('suppressed');
    }
    expect(reserveDispatchSlot).not.toHaveBeenCalled();
    expect(dispatcher.dispatchPropertyAvailabilityCall).not.toHaveBeenCalled();
  });

  it('passes the configured cooldown by default', async () => {
    const reserveDispatchSlot = vi.fn(async () => ({ jobId: 'job-1' }));

    vi.doMock('../src/db/call-log-repository.js', () => ({
      isDatabaseEnabled: () => true,
      ReserveDispatchError,
      getCallLogRepository: () => ({
        isPhoneSuppressed: vi.fn(async () => false),
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
      dispatchPropertyAvailabilityCall: vi.fn(async () => ({
        jobId: 'job-1',
        status: 'dispatched' as const,
        roomName: 'room-1',
        dispatchId: 'dispatch-1',
        agentName: 'test-agent',
        phoneNumber: '+919876543210',
      })),
    };

    const s = settings();
    await secureDispatchPropertyAvailabilityCall(job, s, dispatcher as never);

    expect(reserveDispatchSlot).toHaveBeenCalledWith(job, s.dispatchCooldownMs);
  });

  it('forced: true skips the recent-call cooldown (reserveDispatchSlot called with 0)', async () => {
    const reserveDispatchSlot = vi.fn(async () => ({ jobId: 'job-1' }));

    vi.doMock('../src/db/call-log-repository.js', () => ({
      isDatabaseEnabled: () => true,
      ReserveDispatchError,
      getCallLogRepository: () => ({
        isPhoneSuppressed: vi.fn(async () => false),
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
      dispatchPropertyAvailabilityCall: vi.fn(async () => ({
        jobId: 'job-1',
        status: 'dispatched' as const,
        roomName: 'room-1',
        dispatchId: 'dispatch-1',
        agentName: 'test-agent',
        phoneNumber: '+919876543210',
      })),
    };

    await secureDispatchPropertyAvailabilityCall(job, settings(), dispatcher as never, {
      forced: true,
    });

    expect(reserveDispatchSlot).toHaveBeenCalledWith(job, 0);
  });

  it('forced: true still returns conflict for an already-active call', async () => {
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
        isPhoneSuppressed: vi.fn(async () => false),
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

    const dispatcher = { dispatchPropertyAvailabilityCall: vi.fn() };

    const outcome = await secureDispatchPropertyAvailabilityCall(
      job,
      settings(),
      dispatcher as never,
      { forced: true },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('conflict');
    }
    expect(dispatcher.dispatchPropertyAvailabilityCall).not.toHaveBeenCalled();
  });

  it('marks the property as contacted on GullyNest after a successful dispatch', async () => {
    const reserveDispatchSlot = vi.fn(async () => ({ jobId: 'job-1' }));

    vi.doMock('../src/db/call-log-repository.js', () => ({
      isDatabaseEnabled: () => true,
      ReserveDispatchError,
      getCallLogRepository: () => ({
        isPhoneSuppressed: vi.fn(async () => false),
        reserveDispatchSlot,
        attachDispatch: vi.fn(),
        releaseReservation: vi.fn(),
      }),
    }));

    const markContacted = vi.fn(async () => ({
      ok: true as const,
      property: { id: 'P1', voiceLastContactedAt: new Date().toISOString() },
    }));
    vi.doMock('../src/integrations/gullynest/client.js', () => ({
      createGullyNestClientFromSettings: () => ({ markContacted }),
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
      settingsWithGullyNest(),
      dispatcher as never,
    );

    expect(outcome.ok).toBe(true);
    expect(markContacted).toHaveBeenCalledWith('P1');
  });

  it('does not fail the dispatch when marking as contacted on GullyNest fails', async () => {
    const reserveDispatchSlot = vi.fn(async () => ({ jobId: 'job-1' }));

    vi.doMock('../src/db/call-log-repository.js', () => ({
      isDatabaseEnabled: () => true,
      ReserveDispatchError,
      getCallLogRepository: () => ({
        isPhoneSuppressed: vi.fn(async () => false),
        reserveDispatchSlot,
        attachDispatch: vi.fn(),
        releaseReservation: vi.fn(),
      }),
    }));

    const markContacted = vi.fn(async () => {
      throw new Error('network error');
    });
    vi.doMock('../src/integrations/gullynest/client.js', () => ({
      createGullyNestClientFromSettings: () => ({ markContacted }),
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

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outcome = await secureDispatchPropertyAvailabilityCall(
        job,
        settingsWithGullyNest(),
        dispatcher as never,
      );

      expect(outcome.ok).toBe(true);
      expect(markContacted).toHaveBeenCalledWith('P1');
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
