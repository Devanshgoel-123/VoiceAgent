import { afterEach, describe, expect, it, vi } from 'vitest';

// persistCallResult (below) calls the real safeCompleteCallLog/purgeExpiredCallData, and
// dry-run mode in voice-cron.ts calls isDatabaseEnabled/getCallLogRepository().isPhoneSuppressed —
// mock the DB layer so these tests never touch a real database (this repo's .env loads a real
// DATABASE_URL via dotenv/config, imported transitively through settings.ts).
const { isPhoneSuppressedMock, safeAddPhoneSuppressionMock } = vi.hoisted(() => ({
  isPhoneSuppressedMock: vi.fn(async () => false),
  safeAddPhoneSuppressionMock: vi.fn(async () => {}),
}));
vi.mock('../src/db/call-log-repository.js', () => ({
  safeCompleteCallLog: vi.fn(async () => {}),
  safeAddPhoneSuppression: safeAddPhoneSuppressionMock,
  isDatabaseEnabled: () => true,
  getCallLogRepository: () => ({
    isPhoneSuppressed: isPhoneSuppressedMock,
  }),
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
import {
  createIntervalGate,
  persistCallResult,
} from '../src/jobs/call-outcome-persistence.js';
import type { CallLogSnapshot } from '../src/jobs/call-log-types.js';
import { createPropertyAvailabilityJob } from '../src/jobs/models.js';
import type { Settings } from '../src/config/settings.js';
import {
  CALLABLE_VOICE_STATUSES,
  fetchCallableVoiceProperties,
  isCallableVoiceStatus,
  propertyToJobInput,
  runVoiceCronTick,
  startVoiceCronLoop,
  voiceContactedBeforeCutoff,
  wasContactedWithinCooldown,
} from '../src/jobs/voice-cron.js';
import {
  assertMaxPropertiesNotUsedWithPropertyIds,
  parseListingDateRange,
  parseMaxProperties,
} from '../src/scripts/run-voice-cron.js';
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

  it('skips unanswered (not-connected) calls regardless of status', () => {
    expect(shouldReportCallOutcome(snapshot({ answered: false, status: 'no_answer' }))).toBe(
      false,
    );
    expect(shouldReportCallOutcome(snapshot({ answered: false, status: 'failed' }))).toBe(
      false,
    );
    expect(shouldReportCallOutcome(snapshot({ answered: true, status: 'failed' }))).toBe(
      true,
    );
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

const LISTING_DATE_RANGE = {
  createdAfter: '2026-01-01T00:00:00.000Z',
  createdBefore: '2026-08-01T00:00:00.000Z',
};

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
    apiDispatchRateLimitPerMinute: 30,
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

    await fetchCallableVoiceProperties({ listAllProperties } as never, {
      now,
      ...LISTING_DATE_RANGE,
    });

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
      { now, ...LISTING_DATE_RANGE },
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
      { now, ...LISTING_DATE_RANGE },
    );

    expect(listAllProperties).toHaveBeenCalledOnce();
    expect(listAllProperties).toHaveBeenCalledWith({
      status: 'LIVE,SOFT_STALE',
      listingKind: 'OWNER',
      contactedBefore: '2026-07-20T12:00:00.000Z',
      ...LISTING_DATE_RANGE,
    });
    expect(properties.map((p) => p.id).sort()).toEqual(['live-1', 'soft-1']);
  });

  it('drops TENANT/AGENT listings even if the API returns them', async () => {
    const listAllProperties = vi.fn(async () => [
      property({ id: 'owner-1', listingKind: 'OWNER' }),
      property({ id: 'tenant-1', listingKind: 'TENANT' }),
      property({ id: 'agent-1', listingKind: 'AGENT' }),
    ]);

    const properties = await fetchCallableVoiceProperties(
      { listAllProperties } as never,
      { now, ...LISTING_DATE_RANGE },
    );

    expect(listAllProperties).toHaveBeenCalledWith(
      expect.objectContaining({ listingKind: 'OWNER' }),
    );
    expect(properties.map((p) => p.id)).toEqual(['owner-1']);
  });
});

describe('fetchCallableVoiceProperties targeted mode (propertyIds)', () => {
  it('sends only ids — no status/listingKind/contactedBefore/created filters', async () => {
    const listAllProperties = vi.fn(async () => [property({ id: 'target-1' })]);

    await fetchCallableVoiceProperties({ listAllProperties } as never, {
      propertyIds: 'target-1,target-2',
    });

    expect(listAllProperties).toHaveBeenCalledOnce();
    expect(listAllProperties).toHaveBeenCalledWith({
      ids: 'target-1,target-2',
      status: 'ALL',
    });
  });

  it('does not apply status/listingKind/cooldown filtering to targeted results', async () => {
    const listAllProperties = vi.fn(async () => [
      property({
        id: 'target-stale',
        status: 'STALE',
        listingKind: 'TENANT',
        voiceLastContactedAt: new Date().toISOString(),
      }),
    ]);

    const properties = await fetchCallableVoiceProperties(
      { listAllProperties } as never,
      { propertyIds: 'target-stale' },
    );

    expect(properties.map((p) => p.id)).toEqual(['target-stale']);
  });

  it('does not require createdAfter/createdBefore in targeted mode', async () => {
    const listAllProperties = vi.fn(async () => []);
    await expect(
      fetchCallableVoiceProperties({ listAllProperties } as never, {
        propertyIds: 'target-1',
      }),
    ).resolves.toEqual([]);
  });

  it('ignores maxProperties — returns every requested id, not a capped subset', async () => {
    const listAllProperties = vi.fn(async () => [
      property({ id: 'target-1', shortId: '1' }),
      property({ id: 'target-2', shortId: '2' }),
      property({ id: 'target-3', shortId: '3' }),
    ]);

    const properties = await fetchCallableVoiceProperties(
      { listAllProperties } as never,
      { propertyIds: 'target-1,target-2,target-3', maxProperties: 1 },
    );

    expect(properties).toHaveLength(3);
    // No maxItems argument forwarded to the client either.
    expect(listAllProperties).toHaveBeenCalledWith({
      ids: 'target-1,target-2,target-3',
      status: 'ALL',
    });
  });

  it('still throws for missing createdAfter/createdBefore when propertyIds is not set', async () => {
    const listAllProperties = vi.fn(async () => []);
    await expect(
      fetchCallableVoiceProperties({ listAllProperties } as never, {}),
    ).rejects.toThrow(/createdAfter and createdBefore are required/);
  });
});

describe('runVoiceCronTick', () => {
  afterEach(() => {
    isPhoneSuppressedMock.mockReset().mockResolvedValue(false);
  });

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
      ...LISTING_DATE_RANGE,
    });

    expect(listAllProperties).toHaveBeenCalledOnce();
    expect(listAllProperties).toHaveBeenCalledWith({
      status: 'LIVE,SOFT_STALE',
      listingKind: 'OWNER',
      contactedBefore: '2026-07-20T12:00:00.000Z',
      ...LISTING_DATE_RANGE,
    });
    expect(summary.skipped).toBe(1);
    expect(summary.dispatched).toBe(2);
    expect(summary.failed).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(summary.items.some((i) => i.propertyId === 'a' && i.status === 'skipped')).toBe(
      true,
    );
  });

  it('logs one line per property with propertyId, status, and reason (dispatched/skipped/failed)', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [
      property({ id: 'ok-1', listerPhone: '+919555555555' }),
      property({ id: 'skipped-1', listerPhone: null }),
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

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runVoiceCronTick(baseSettings(), {
        client: { listAllProperties } as never,
        dispatch,
        now,
        ...LISTING_DATE_RANGE,
      });

      const dispatchedLine = JSON.parse(
        logSpy.mock.calls.find(([line]) => String(line).includes('ok-1'))![0] as string,
      );
      expect(dispatchedLine).toMatchObject({
        event: 'voice_cron_item',
        propertyId: 'ok-1',
        status: 'dispatched',
      });
      expect(dispatchedLine.jobId).toBeDefined();

      const skippedLine = JSON.parse(
        logSpy.mock.calls.find(([line]) => String(line).includes('skipped-1'))![0] as string,
      );
      expect(skippedLine).toMatchObject({
        event: 'voice_cron_item',
        propertyId: 'skipped-1',
        status: 'skipped',
        reason: 'missing_phone_or_address',
      });

      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs failed items to console.error with the reason', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [property({ id: 'fail-1' })]);
    const dispatch = vi.fn(async () => ({
      ok: false as const,
      failure: {
        kind: 'compliance' as const,
        status: 403 as const,
        error: 'quiet hours',
        reason: 'outside_calling_hours',
      },
    }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runVoiceCronTick(baseSettings(), {
        client: { listAllProperties } as never,
        dispatch,
        now,
        ...LISTING_DATE_RANGE,
      });

      expect(errorSpy).toHaveBeenCalledOnce();
      const line = JSON.parse(errorSpy.mock.calls[0]![0] as string);
      expect(line).toMatchObject({
        event: 'voice_cron_item',
        propertyId: 'fail-1',
        status: 'failed',
      });
      expect(line.reason).toContain('compliance');
    } finally {
      errorSpy.mockRestore();
    }
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
      ...LISTING_DATE_RANGE,
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
      ...LISTING_DATE_RANGE,
    });

    expect(summary.dispatched).toBe(1);
    expect(summary.items[0]).toMatchObject({
      propertyId: 'soft-1',
      status: 'dispatched',
      phoneNumber: '+919222222222',
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('keeps owner phone numbers out of the long-running loop tick log', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const listAllProperties = vi.fn(async () => [
      property({ id: 'p1', listerPhone: '+919876543210' }),
    ]);
    const handle = startVoiceCronLoop(baseSettings(), {
      client: { listAllProperties } as never,
      dryRun: true,
      now: new Date('2026-07-27T06:00:00.000Z'),
      ...LISTING_DATE_RANGE,
    });

    try {
      await vi.waitFor(() => {
        expect(logSpy.mock.calls.some(([line]) => String(line).includes('tickAt'))).toBe(true);
      });
      const tickLine = logSpy.mock.calls
        .map(([line]) => String(line))
        .find((line) => line.includes('tickAt'))!;
      expect(tickLine).toContain('"propertyId":"p1"');
      expect(tickLine).not.toContain('9876543210');
    } finally {
      handle.stop();
      logSpy.mockRestore();
    }
  });

  it('skips a lister phone that is not E.164 instead of dialing it', async () => {
    const now = new Date('2026-07-27T06:00:00.000Z');
    const listAllProperties = vi.fn(async () => [
      property({ id: 'bare-digits', listerPhone: '9876543210' }),
      property({ id: 'spaced', listerPhone: '+91 98765 43210' }),
      property({ id: 'ok', listerPhone: '+919876543210' }),
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
      ...LISTING_DATE_RANGE,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(summary.items).toContainEqual(
      expect.objectContaining({ propertyId: 'bare-digits', status: 'skipped', reason: 'invalid_phone' }),
    );
    expect(summary.items).toContainEqual(
      expect.objectContaining({ propertyId: 'spaced', status: 'skipped', reason: 'invalid_phone' }),
    );
    expect(summary.items).toContainEqual(
      expect.objectContaining({ propertyId: 'ok', status: 'dispatched' }),
    );
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
      ...LISTING_DATE_RANGE,
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

  it('dry run: lists what would be dispatched without calling dispatch or reserving anything', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [
      property({ id: 'preview-1', listerPhone: '+919666666666' }),
    ]);
    const dispatch = vi.fn();

    const summary = await runVoiceCronTick(baseSettings(), {
      client: { listAllProperties } as never,
      dispatch,
      now,
      dryRun: true,
      ...LISTING_DATE_RANGE,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.dryRun).toBe(true);
    expect(summary.dispatched).toBe(0);
    expect(summary.wouldDispatch).toBe(1);
    expect(summary.items[0]).toMatchObject({
      propertyId: 'preview-1',
      status: 'would_dispatch',
      phoneNumber: '+919666666666',
    });
    expect(summary.items[0]!.jobId).toBeUndefined();
  });

  it('dry run: still shows a property as skipped if it would be blocked by compliance', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [
      property({ id: 'suppressed-1', listerPhone: '+919777777777' }),
    ]);
    const dispatch = vi.fn();
    isPhoneSuppressedMock.mockResolvedValueOnce(true);

    const summary = await runVoiceCronTick(baseSettings(), {
      client: { listAllProperties } as never,
      dispatch,
      now,
      dryRun: true,
      ...LISTING_DATE_RANGE,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.wouldDispatch).toBe(0);
    expect(summary.items[0]).toMatchObject({
      propertyId: 'suppressed-1',
      status: 'skipped',
      reason: 'would_be_blocked: suppressed',
    });
  });

  it('targeted mode: does not require createdAfter/createdBefore when propertyIds is set', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async (query) => {
      expect(query).toEqual({ ids: 'target-1', status: 'ALL' });
      return [property({ id: 'target-1', status: 'STALE', listingKind: 'AGENT' })];
    });
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
      propertyIds: 'target-1',
    });

    expect(summary.dispatched).toBe(1);
    expect(summary.items[0]).toMatchObject({ propertyId: 'target-1', status: 'dispatched' });
  });

  it('throws when neither propertyIds nor createdAfter/createdBefore are given', async () => {
    await expect(
      runVoiceCronTick(baseSettings(), {
        client: { listAllProperties: vi.fn() } as never,
        dispatch: vi.fn(),
      }),
    ).rejects.toThrow(/unless --property-id is set/);
  });

  it('forwards deps.forced through to the dispatch call', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [property({ id: 'p1' })]);
    const dispatch = vi.fn(
      async (
        job: ReturnType<typeof createPropertyAvailabilityJob>,
        _settings: Settings,
        _options?: { forced?: boolean },
      ) => ({
        ok: true as const,
        result: {
          jobId: job.jobId,
          status: 'dispatched' as const,
          roomName: 'room',
          dispatchId: 'd1',
          agentName: 'test-agent',
          phoneNumber: job.owner.phoneNumber,
        },
      }),
    );

    await runVoiceCronTick(baseSettings(), {
      client: { listAllProperties } as never,
      dispatch,
      now,
      forced: true,
      ...LISTING_DATE_RANGE,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![2]).toEqual({ forced: true });
  });

  it('defaults forced to undefined when not set', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const listAllProperties = vi.fn(async () => [property({ id: 'p1' })]);
    const dispatch = vi.fn(
      async (
        job: ReturnType<typeof createPropertyAvailabilityJob>,
        _settings: Settings,
        _options?: { forced?: boolean },
      ) => ({
        ok: true as const,
        result: {
          jobId: job.jobId,
          status: 'dispatched' as const,
          roomName: 'room',
          dispatchId: 'd1',
          agentName: 'test-agent',
          phoneNumber: job.owner.phoneNumber,
        },
      }),
    );

    await runVoiceCronTick(baseSettings(), {
      client: { listAllProperties } as never,
      dispatch,
      now,
      ...LISTING_DATE_RANGE,
    });

    expect(dispatch.mock.calls[0]![2]).toEqual({ forced: undefined });
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

describe('assertMaxPropertiesNotUsedWithPropertyIds', () => {
  it('throws when both --property-id and --max-properties are set', () => {
    expect(() => assertMaxPropertiesNotUsedWithPropertyIds('id-1', 10)).toThrow(
      /--max-properties has no effect with --property-id/,
    );
  });

  it('is a no-op when only one (or neither) is set', () => {
    expect(() => assertMaxPropertiesNotUsedWithPropertyIds('id-1', undefined)).not.toThrow();
    expect(() => assertMaxPropertiesNotUsedWithPropertyIds(undefined, 10)).not.toThrow();
    expect(() =>
      assertMaxPropertiesNotUsedWithPropertyIds(undefined, undefined),
    ).not.toThrow();
  });
});

describe('parseListingDateRange (--created-after/--created-before, YYYY-MM-DD IST)', () => {
  it('converts IST calendar dates to the matching UTC instant', () => {
    expect(
      parseListingDateRange(['--created-after=2026-07-01', '--created-before=2026-07-15']),
    ).toEqual({
      createdAfter: '2026-06-30T18:30:00.000Z',
      createdBefore: '2026-07-14T18:30:00.000Z',
    });
  });

  it('throws if either flag is missing', () => {
    expect(() => parseListingDateRange(['--created-after=2026-07-01'])).toThrow(
      /both required/,
    );
    expect(() => parseListingDateRange(['--created-before=2026-07-15'])).toThrow(
      /both required/,
    );
    expect(() => parseListingDateRange([])).toThrow(/both required/);
  });

  it('explains inclusive/exclusive semantics in the missing-flag error', () => {
    expect(() => parseListingDateRange([])).toThrow(
      /--created-after is inclusive.*--created-before is exclusive/s,
    );
  });

  it('rejects ISO datetimes and other non-YYYY-MM-DD input', () => {
    expect(() =>
      parseListingDateRange([
        '--created-after=2026-07-01T00:00:00Z',
        '--created-before=2026-07-15',
      ]),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      parseListingDateRange(['--created-after=07-01-2026', '--created-before=2026-07-15']),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('rejects a calendar date that does not exist', () => {
    expect(() =>
      parseListingDateRange(['--created-after=2026-02-30', '--created-before=2026-07-15']),
    ).toThrow(/not a real calendar date/);
  });

  it('rejects a range where after is not earlier than before', () => {
    expect(() =>
      parseListingDateRange(['--created-after=2026-07-15', '--created-before=2026-07-01']),
    ).toThrow(/must be earlier/);
    expect(() =>
      parseListingDateRange(['--created-after=2026-07-01', '--created-before=2026-07-01']),
    ).toThrow(/must be earlier/);
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
      { now, ...LISTING_DATE_RANGE },
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
      { now, maxProperties: 2, ...LISTING_DATE_RANGE },
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

  it('never calls the outcome API for a no_answer (unconnected) snapshot', async () => {
    const fetchImpl = stubOutcomeFetch();

    await persistCallResult(
      snapshot({ status: 'no_answer', ownerOutcome: 'other', answered: false }),
      gullyNestSettings(),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never calls the outcome API for a failed-to-connect (dial error) snapshot', async () => {
    const fetchImpl = stubOutcomeFetch();

    await persistCallResult(
      snapshot({ status: 'failed', ownerOutcome: 'other', answered: false }),
      gullyNestSettings(),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still reports soft_stale for an answered call with an unclear/failed outcome', async () => {
    const fetchImpl = stubOutcomeFetch();

    await persistCallResult(
      snapshot({ status: 'failed', ownerOutcome: 'other', answered: true }),
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

  it('never reports an outcome for a console-test snapshot', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await persistCallResult(
      snapshot({ jobId: 'console-test-job', propertyId: 'PROP-CONSOLE-001' }),
      gullyNestSettings(),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('suppresses the number when the owner asked not to be called again', async () => {
    stubOutcomeFetch();
    safeAddPhoneSuppressionMock.mockClear();

    await persistCallResult(
      snapshot({
        ownerOutcome: 'other',
        metadata: { do_not_call: true, do_not_call_reason: 'please stop calling me' },
      }),
      gullyNestSettings(),
    );

    expect(safeAddPhoneSuppressionMock).toHaveBeenCalledOnce();
    const [phone, reason] = safeAddPhoneSuppressionMock.mock.calls[0]! as unknown as [
      string,
      string,
    ];
    expect(phone).toBe('+919876543210');
    expect(reason).toContain('job-1');
    expect(reason).toContain('please stop calling me');
  });

  it('does not suppress the number for an ordinary outcome', async () => {
    stubOutcomeFetch();
    safeAddPhoneSuppressionMock.mockClear();

    await persistCallResult(snapshot({ ownerOutcome: 'no' }), gullyNestSettings());

    expect(safeAddPhoneSuppressionMock).not.toHaveBeenCalled();
  });
});

describe('createIntervalGate (retention sweep throttle)', () => {
  it('passes the first call, then at most once per interval', () => {
    const gate = createIntervalGate(1_000);
    expect(gate(10_000)).toBe(true);
    expect(gate(10_500)).toBe(false);
    expect(gate(10_999)).toBe(false);
    expect(gate(11_000)).toBe(true);
    expect(gate(11_001)).toBe(false);
  });
});
