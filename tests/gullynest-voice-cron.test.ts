import { describe, expect, it, vi } from 'vitest';
import {
  GullyNestApiError,
  GullyNestClient,
} from '../src/integrations/gullynest/client.js';
import {
  mapSnapshotToCallOutcomeAction,
  shouldReportCallOutcome,
} from '../src/integrations/gullynest/outcome-map.js';
import type { CallLogSnapshot } from '../src/jobs/call-log-types.js';
import type { Settings } from '../src/config/settings.js';
import { propertyToJobInput, runVoiceCron } from '../src/jobs/voice-cron.js';
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

    await client.listProperties({
      status: 'LIVE',
      listingKind: 'OWNER,AGENT',
      contactedBefore: '2026-07-17T00:00:00.000Z',
      page: 2,
      pageSize: 100,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('https://example.com/api/voice-admin/properties?');
    expect(String(url)).toContain('status=LIVE');
    expect(String(url)).toContain('listingKind=OWNER%2CAGENT');
    expect(String(url)).toContain('page=2');
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
    dispatchCooldownMs: 86_400_000,
    callingHoursStartHour: 0,
    callingHoursEndHour: 24,
    callingHoursTimeZone: 'UTC',
    callDataRetentionDays: 15,
    apiWriteRateLimitPerMinute: 30,
    apiReadRateLimitPerMinute: 60,
    voiceAgentApiBaseUrl: 'https://example.com',
    voiceAgentApiSecret: 'secret',
    voiceCronPageSize: 50,
    voiceCronMaxDispatch: 2,
    voiceCronConcurrency: 2,
    voiceCronRecontactDays: 7,
    voiceCronStatus: 'LIVE',
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

describe('runVoiceCron', () => {
  it('skips properties without phone and respects max dispatch', async () => {
    const listAllProperties = vi.fn(async () => [
      property({ id: 'a', listerPhone: null }),
      property({ id: 'b', shortId: '1' }),
      property({
        id: 'c',
        shortId: '2',
        listerPhone: '+919111111111',
        listerName: 'Sita',
      }),
      property({
        id: 'd',
        shortId: '3',
        listerPhone: '+919222222222',
        listerName: 'Amit',
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

    const summary = await runVoiceCron(baseSettings({ voiceCronMaxDispatch: 2 }), {
      client: { listAllProperties } as never,
      dispatch,
      now: () => new Date('2026-07-24T12:00:00.000Z'),
    });

    expect(listAllProperties).toHaveBeenCalledOnce();
    const query = listAllProperties.mock.calls[0]![0];
    expect(query.contactedBefore).toBe('2026-07-17T12:00:00.000Z');
    expect(summary.skipped).toBe(1);
    expect(summary.dispatched).toBe(2);
    expect(summary.failed).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(summary.items.some((i) => i.propertyId === 'a' && i.status === 'skipped')).toBe(
      true,
    );
  });

  it('records dispatch failures without throwing', async () => {
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

    const summary = await runVoiceCron(baseSettings(), {
      client: { listAllProperties } as never,
      dispatch,
    });

    expect(summary.dispatched).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.items[0]?.reason).toContain('compliance');
  });
});
