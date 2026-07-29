import { afterEach, describe, expect, it, vi } from 'vitest';

// persistCallResult (below) calls the real safeCompleteCallLog/purgeExpiredCallData —
// mock the DB layer so these tests never touch a real database (this repo's .env loads
// a real DATABASE_URL via dotenv/config, imported transitively through settings.ts).
vi.mock('../src/db/call-log-repository.js', () => ({
  safeCompleteCallLog: vi.fn(async () => {}),
}));
vi.mock('../src/jobs/retention.js', () => ({
  purgeExpiredCallData: vi.fn(async () => 0),
}));

import { VOICE_CRON_PROPERTY_STATUSES } from '../src/config/call-config.js';
import {
  GullyNestApiError,
  GullyNestClient,
} from '../src/integrations/gullynest/client.js';
import {
  mapSnapshotToCallOutcomeAction,
  shouldReportCallOutcome,
} from '../src/integrations/gullynest/outcome-map.js';
import { persistCallResult } from '../src/jobs/call-outcome-persistence.js';
import type { CallLogSnapshot } from '../src/jobs/call-log-types.js';
import type { Settings } from '../src/config/settings.js';
import {
  CALLABLE_VOICE_STATUSES,
  fetchCallableVoiceProperties,
  isCallableVoiceStatus,
  propertyToJobInput,
  runVoiceCronTick,
  voiceContactedBeforeCutoff,
  wasContactedWithinCooldown,
} from '../src/jobs/voice-cron.js';
import { parseMaxProperties } from '../src/scripts/run-voice-cron.js';
import type { VoiceAdminProperty } from '../src/integrations/gullynest/types.js';

function snapshot(
  overrides: Partial<CallLogSnapshot> = {},
): CallLogSnapshot {
  return {
    jobId: 'job-1',
    direction: 'outbound',
    status: 'completed',
    ownerOutcome: 'yes',
    success: true,
    answered: true,
    propertyId: 'cmqproperty1',
    phoneNumber: '+919876543210',
    languages: ['en-IN'],
    transcript: [],
    metadata: {},
    ...overrides,
  };
}

describe('mapSnapshotToCallOutcomeAction', () => {
  it('maps yes to available', () => {
    expect(mapSnapshotToCallOutcomeAction(snapshot({ ownerOutcome: 'yes' }))).toBe(
      'available',
    );
  });

  it('maps no to stale', () => {
    expect(mapSnapshotToCallOutcomeAction(snapshot({ ownerOutcome: 'no' }))).toBe(
      'stale',
    );
  });

  it('maps an ownership mismatch to stale so it is not called again', () => {
    expect(
      mapSnapshotToCallOutcomeAction(
        snapshot({
          ownerOutcome: 'other',
          metadata: { call_end_reason: 'ownership_mismatch' },
        }),
      ),
    ).toBe('stale');
  });

  it('maps other / no_answer to soft_stale', () => {
    expect(
      mapSnapshotToCallOutcomeAction(
        snapshot({ ownerOutcome: 'other', status: 'no_answer' }),
      ),
    ).toBe('soft_stale');
    expect(
      mapSnapshotToCallOutcomeAction(
        snapshot({ ownerOutcome: 'unclear', status: 'completed' }),
      ),
    ).toBe('soft_stale');
  });
});

describe('shouldReportCallOutcome', () => {
  it('skips console and missing property ids', () => {
    expect(shouldReportCallOutcome(snapshot({ propertyId: undefined }))).toBe(false);
    expect(
      shouldReportCallOutcome(snapshot({ jobId: 'console-test-job' })),
    ).toBe(false);
    expect(
      shouldReportCallOutcome(snapshot({ propertyId: 'PROP-CONSOLE-001' })),
    ).toBe(false);
    expect(shouldReportCallOutcome(snapshot())).toBe(true);
  });
});

describe('GullyNestClient', () => {
  it('lists properties with auth header and query params', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [],
          page: 1,
          pageSize: 50,
          total: 0,
          totalPages: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new GullyNestClient({
      baseUrl: 'https://example.com/',
      apiSecret: 'secret-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.listProperties({ page: 2, pageSize: 100 });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://example.com/api/voice-admin/properties?page=2&pageSize=100',
    );
    expect((init as RequestInit).headers).toMatchObject({
      'X-Voice-Admin-Secret': 'secret-123',
    });
  });

  it('reports call outcome via PATCH', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          action: 'stale',
          property: {
            id: 'cmq1',
            status: 'STALE',
            voiceLastContactedAt: '2026-07-24T10:00:00.000Z',
            updatedAt: '2026-07-24T10:00:00.000Z',
          },
        }),
        { status: 200 },
      ),
    );

    const client = new GullyNestClient({
      baseUrl: 'https://example.com',
      apiSecret: 'secret-123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.reportCallOutcome('042817', 'stale');
    expect(result.action).toBe('stale');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://example.com/api/voice-admin/properties/042817/call-outcome',
    );
    expect((init as RequestInit).method).toBe('PATCH');
    expect((init as RequestInit).body).toBe(JSON.stringify({ action: 'stale' }));
  });

  it('throws GullyNestApiError on non-2xx', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('unauthorized', { status: 401 }),
    );
    const client = new GullyNestClient({
      baseUrl: 'https://example.com',
      apiSecret: 'bad',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.listProperties()).rejects.toBeInstanceOf(GullyNestApiError);
  });

  it('passes an AbortSignal to fetchImpl on every request', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ items: [], page: 1, pageSize: 50, total: 0, totalPages: 0 }),
        { status: 200 },
      ),
    );
    const client = new GullyNestClient({
      baseUrl: 'https://example.com',
      apiSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.listProperties();

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a request that never resolves once requestTimeoutMs elapses', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );
    const client = new GullyNestClient({
      baseUrl: 'https://example.com',
      apiSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestTimeoutMs: 30,
    });

    await expect(client.listProperties()).rejects.toThrow(/aborted/i);
  }, 2000);
});

function baseSettings(overrides: Partial<Settings> = {}): Settings {
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
    dispatchCooldownMs: 7 * 24 * 60 * 60 * 1000,
    callingHoursStartHour: 0,
    callingHoursEndHour: 24,
    callingHoursTimeZone: 'UTC',
    callDataRetentionDays: 15,
    apiReadRateLimitPerMinute: 60,
    apiSuppressionWriteRateLimitPerMinute: 10,
    voiceAgentApiBaseUrl: 'https://example.com',
    voiceAgentApiSecret: 'secret',
    voiceCronIntervalMs: 900_000,
    appEnv: 'developer',
    callDebugLogging: false,
    databaseUrl: 'postgresql://example',
    ...overrides,
  };
}

function property(overrides: Partial<VoiceAdminProperty> = {}): VoiceAdminProperty {
  return {
    id: 'cmq1',
    shortId: '042817',
    status: 'LIVE',
    listingKind: 'OWNER',
    listingUnitType: 'FLAT',
    bhk: '2 BHK',
    rentMonthly: 25000,
    city: 'Bengaluru',
    locality: 'Indiranagar',
    subLocality: null,
    formattedAddress: '42 Indiranagar, Bengaluru',
    listerName: 'Ramesh',
    listerPhone: '+919876543210',
    voiceLastContactedAt: null,
    createdAt: '2026-07-01T09:15:00.000Z',
    ...overrides,
  };
}

describe('propertyToJobInput', () => {
  it('defaults missing listerName to Owner', () => {
    const input = propertyToJobInput(
      property({ listerName: null }),
      baseSettings(),
    );
    expect(input).not.toBeNull();
    expect(input!.owner.name).toBe('Owner');
    expect(input!.property.locality).toBe('Indiranagar');
  });

  it('still skips when phone or address is missing', () => {
    expect(
      propertyToJobInput(property({ listerPhone: null }), baseSettings()),
    ).toBeNull();
    expect(
      propertyToJobInput(property({ formattedAddress: null }), baseSettings()),
    ).toBeNull();
  });
});

describe('voice cron property status filters', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');

  it('configures LIVE and SOFT_STALE for cron fetches', () => {
    expect([...VOICE_CRON_PROPERTY_STATUSES]).toEqual(['LIVE', 'SOFT_STALE']);
    expect([...CALLABLE_VOICE_STATUSES]).toEqual(['LIVE', 'SOFT_STALE']);
  });

  it('only treats LIVE and SOFT_STALE as callable', () => {
    expect(isCallableVoiceStatus('LIVE')).toBe(true);
    expect(isCallableVoiceStatus('SOFT_STALE')).toBe(true);
    expect(isCallableVoiceStatus('STALE')).toBe(false);
  });

  it('fetches LIVE + SOFT_STALE in a single comma-joined status request', async () => {
    const listAllProperties = vi.fn(async () => []);

    await fetchCallableVoiceProperties({ listAllProperties } as never, now);

    expect(listAllProperties).toHaveBeenCalledOnce();
    const [query] = listAllProperties.mock.calls[0]!;
    expect((query as { status?: string }).status).toBe('LIVE,SOFT_STALE');
    expect((query as { contactedBefore?: string }).contactedBefore).toBe(
      '2026-07-20T12:00:00.000Z',
    );
  });

  it('drops STALE rows even if the API returns them', async () => {
    const listAllProperties = vi.fn(async () => [
      property({ id: 'live-1' }),
      property({ id: 'soft-1', status: 'SOFT_STALE' }),
      property({ id: 'stale-1', status: 'STALE' }),
    ]);

    const properties = await fetchCallableVoiceProperties(
      { listAllProperties } as never,
      now,
    );

    expect(listAllProperties).toHaveBeenCalledOnce();
    expect(properties.map((p) => p.id).sort()).toEqual(['live-1', 'soft-1']);
    expect(properties.some((p) => p.status === 'STALE')).toBe(false);
  });
});

describe('voice recontact filters', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');

  it('builds a 7-day contactedBefore cutoff', () => {
    expect(voiceContactedBeforeCutoff(now)).toBe('2026-07-20T12:00:00.000Z');
  });

  it('detects recent voice contacts', () => {
    expect(
      wasContactedWithinCooldown(
        { voiceLastContactedAt: '2026-07-24T12:00:00.000Z' },
        now,
      ),
    ).toBe(true);
    expect(
      wasContactedWithinCooldown(
        { voiceLastContactedAt: '2026-07-19T12:00:00.000Z' },
        now,
      ),
    ).toBe(false);
    expect(wasContactedWithinCooldown({ voiceLastContactedAt: null }, now)).toBe(
      false,
    );
  });

  it('fetches LIVE and SOFT_STALE with contactedBefore, filtering recently-contacted rows', async () => {
    const listAllProperties = vi.fn(async () => [
      property({ id: 'live-1' }),
      property({
        id: 'live-recent',
        voiceLastContactedAt: '2026-07-25T00:00:00.000Z',
      }),
      property({ id: 'soft-1', status: 'SOFT_STALE' }),
      property({ id: 'stale-1', status: 'STALE' }),
    ]);

    const properties = await fetchCallableVoiceProperties(
      { listAllProperties } as never,
      now,
    );

    expect(listAllProperties).toHaveBeenCalledOnce();
    expect(listAllProperties).toHaveBeenCalledWith({
      status: 'LIVE,SOFT_STALE',
      contactedBefore: '2026-07-20T12:00:00.000Z',
    });
    expect(properties.map((p) => p.id).sort()).toEqual(['live-1', 'soft-1']);
  });
});

describe('runVoiceCronTick', () => {
  it('dispatches each callable property from the API response', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [
      property({ id: 'a', listerPhone: null }),
      property({ id: 'b', shortId: '1' }),
      property({
        id: 'c',
        shortId: '2',
        listerPhone: '+919111111111',
        listerName: 'Sita',
      }),
    ]);

    const dispatch = vi.fn(async (job) => ({
      ok: true as const,
      result: {
        jobId: job.jobId,
        status: 'dispatched' as const,
        roomName: 'room',
        dispatchId: 'd1',
        agentName: 'test-agent',
        phoneNumber: job.owner.phoneNumber,
      },
    }));

    const summary = await runVoiceCronTick(baseSettings(), {
      client: { listAllProperties } as never,
      dispatch,
      now,
    });

    expect(listAllProperties).toHaveBeenCalledOnce();
    expect(listAllProperties).toHaveBeenCalledWith({
      status: 'LIVE,SOFT_STALE',
      contactedBefore: '2026-07-20T12:00:00.000Z',
    });
    expect(summary.skipped).toBe(1);
    expect(summary.dispatched).toBe(2);
    expect(summary.failed).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(summary.items.some((i) => i.propertyId === 'a' && i.status === 'skipped')).toBe(
      true,
    );
  });

  it('records dispatch failures without throwing', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [property()]);
    const dispatch = vi.fn(async () => ({
      ok: false as const,
      failure: {
        kind: 'compliance' as const,
        status: 403 as const,
        error: 'quiet hours',
        reason: 'outside_calling_hours',
      },
    }));

    const summary = await runVoiceCronTick(baseSettings(), {
      client: { listAllProperties } as never,
      dispatch,
      now,
    });

    expect(summary.dispatched).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.items[0]?.reason).toContain('compliance');
  });

  it('dispatches SOFT_STALE properties returned by the cron fetch', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [
      property({
        id: 'soft-1',
        status: 'SOFT_STALE',
        listerPhone: '+919222222222',
        listerName: 'Anita',
      }),
    ]);

    const dispatch = vi.fn(async (job) => ({
      ok: true as const,
      result: {
        jobId: job.jobId,
        status: 'dispatched' as const,
        roomName: 'room-soft',
        dispatchId: 'd-soft',
        agentName: 'test-agent',
        phoneNumber: job.owner.phoneNumber,
      },
    }));

    const summary = await runVoiceCronTick(baseSettings(), {
      client: { listAllProperties } as never,
      dispatch,
      now,
    });

    expect(summary.dispatched).toBe(1);
    expect(summary.items[0]).toMatchObject({
      propertyId: 'soft-1',
      status: 'dispatched',
      phoneNumber: '+919222222222',
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('queues later properties for the same listerPhone instead of dispatching them concurrently', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [
      property({ id: 'flat-1', shortId: '1', listerPhone: '+919333333333' }),
      property({ id: 'flat-2', shortId: '2', listerPhone: '+919333333333' }),
      property({ id: 'flat-3', shortId: '3', listerPhone: '+919444444444' }),
    ]);

    const dispatch = vi.fn(async (job) => ({
      ok: true as const,
      result: {
        jobId: job.jobId,
        status: 'dispatched' as const,
        roomName: 'room',
        dispatchId: 'd1',
        agentName: 'test-agent',
        phoneNumber: job.owner.phoneNumber,
      },
    }));

    const summary = await runVoiceCronTick(baseSettings(), {
      client: { listAllProperties } as never,
      dispatch,
      now,
    });

    // Only one call per phone number this tick — flat-1 goes out, flat-2 (same
    // owner) queues for a later tick, flat-3 (different owner) goes out too.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(summary.dispatched).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.items).toContainEqual(
      expect.objectContaining({
        propertyId: 'flat-1',
        status: 'dispatched',
        phoneNumber: '+919333333333',
      }),
    );
    expect(summary.items).toContainEqual(
      expect.objectContaining({
        propertyId: 'flat-2',
        status: 'skipped',
        reason: 'queued_same_phone_this_tick',
        phoneNumber: '+919333333333',
      }),
    );
    expect(summary.items).toContainEqual(
      expect.objectContaining({
        propertyId: 'flat-3',
        status: 'dispatched',
        phoneNumber: '+919444444444',
      }),
    );
  });
});

describe('parseMaxProperties (--max-properties CLI flag)', () => {
  it('returns undefined when not passed', () => {
    expect(parseMaxProperties(['--once'])).toBeUndefined();
  });

  it('parses --max-properties=<n>', () => {
    expect(parseMaxProperties(['--once', '--max-properties=50'])).toBe(50);
  });

  it('parses --max-properties <n> as two args', () => {
    expect(parseMaxProperties(['--max-properties', '25', '--once'])).toBe(25);
  });

  it('throws on a non-positive-integer value', () => {
    expect(() => parseMaxProperties(['--max-properties=0'])).toThrow();
    expect(() => parseMaxProperties(['--max-properties=abc'])).toThrow();
    expect(() => parseMaxProperties(['--max-properties=-5'])).toThrow();
  });
});

describe('fetchCallableVoiceProperties maxProperties cap', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');

  it('fetches everything when no cap is given', async () => {
    const listAllProperties = vi.fn(async () => [
      property({ id: 'live-1' }),
      property({ id: 'live-2', shortId: '2' }),
      property({ id: 'soft-1', status: 'SOFT_STALE', shortId: '3' }),
    ]);

    const properties = await fetchCallableVoiceProperties(
      { listAllProperties } as never,
      now,
    );

    expect(properties).toHaveLength(3);
    expect(listAllProperties).toHaveBeenCalledOnce();
    expect(listAllProperties.mock.calls[0]).toHaveLength(1);
  });

  it('caps the result and forwards the cap to the single fetch call', async () => {
    const listAllProperties = vi.fn(async () => [
      property({ id: 'live-1' }),
      property({ id: 'live-2', shortId: '2' }),
      property({ id: 'soft-1', status: 'SOFT_STALE', shortId: '3' }),
    ]);

    const properties = await fetchCallableVoiceProperties(
      { listAllProperties } as never,
      now,
      2,
    );

    expect(properties).toHaveLength(2);
    expect(listAllProperties).toHaveBeenCalledOnce();
    expect(listAllProperties.mock.calls[0]![1]).toBe(2);
  });
});

describe('persistCallResult (GullyNest outcome reporting)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function gullyNestSettings(): Settings {
    return baseSettings({
      voiceAgentApiBaseUrl: 'https://example.com',
      voiceAgentApiSecret: 'secret-123',
    });
  }

  function stubOutcomeFetch() {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          action: 'soft_stale',
          property: {
            id: 'cmqproperty1',
            status: 'SOFT_STALE',
            voiceLastContactedAt: '2026-07-27T12:00:00.000Z',
            updatedAt: '2026-07-27T12:00:00.000Z',
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);
    return fetchImpl;
  }

  it('reports soft_stale for a no_answer snapshot (the previously-missing case)', async () => {
    const fetchImpl = stubOutcomeFetch();

    await persistCallResult(
      snapshot({ status: 'no_answer', ownerOutcome: 'other', answered: false }),
      gullyNestSettings(),
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://example.com/api/voice-admin/properties/cmqproperty1/call-outcome',
    );
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      action: 'soft_stale',
    });
  });

  it('reports soft_stale for a failed (dial error) snapshot', async () => {
    const fetchImpl = stubOutcomeFetch();

    await persistCallResult(
      snapshot({ status: 'failed', ownerOutcome: 'other', answered: false }),
      gullyNestSettings(),
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      action: 'soft_stale',
    });
  });

  it('never reports an outcome for a console-test snapshot', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await persistCallResult(
      snapshot({ jobId: 'console-test-job', propertyId: 'PROP-CONSOLE-001' }),
      gullyNestSettings(),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
