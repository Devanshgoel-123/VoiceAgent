import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Settings } from '../src/config/settings.js';

const mockSecureDispatch = vi.fn();

vi.mock('../src/jobs/dispatch-pipeline.js', () => ({
  secureDispatchPropertyAvailabilityCall: (...args: unknown[]) =>
    mockSecureDispatch(...args),
}));

vi.mock('../src/db/call-log-repository.js', () => ({
  isDatabaseEnabled: () => true,
  getCallLogRepository: vi.fn(() => ({
    getByJobId: vi.fn(async () => null),
    listRecent: vi.fn(async () => []),
    getCallPreference: vi.fn(async () => null),
    upsertCallPreference: vi.fn(async (input: { phoneNumber: string }) => ({
      phoneNumber: input.phoneNumber,
      consentStatus: 'unknown',
      consentSource: null,
      consentAt: null,
      dnd: false,
      dndSource: null,
      dndAt: null,
      optedOutAt: null,
      optOutReason: null,
      updatedAt: new Date(),
      createdAt: new Date(),
      id: 'pref-1',
    })),
  })),
}));

export function testSettings(overrides: Partial<Settings> = {}): Settings {
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
    appEnv: 'developer',
    callDebugLogging: false,
    ...overrides,
  };
}

describe('API server', () => {
  beforeEach(() => {
    mockSecureDispatch.mockReset();
    mockSecureDispatch.mockResolvedValue({
      ok: true,
      result: {
        jobId: 'job-1',
        status: 'dispatched',
        roomName: 'room-1',
        dispatchId: 'dispatch-1',
        agentName: 'test-agent',
        phoneNumber: '+919876543210',
      },
    });
  });

  it('rejects unauthenticated dispatch requests', async () => {
    const { createApp } = await import('../src/api/app.js');
    const app = createApp(testSettings());

    const res = await request(app)
      .post('/calls/property-availability')
      .send({
        owner_name: 'Ramesh',
        phone_number: '+919876543210',
        property_id: 'P1',
        property_address: '42 Indiranagar',
      });

    expect(res.status).toBe(401);
  });

  it('validates E.164 phone numbers', async () => {
    const { createApp } = await import('../src/api/app.js');
    const app = createApp(testSettings());

    const res = await request(app)
      .post('/calls/property-availability')
      .set('Authorization', 'Bearer test-secret')
      .send({
        owner_name: 'Ramesh',
        phone_number: '9876543210',
        property_id: 'P1',
        property_address: '42 Indiranagar',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request body');
  });

  it('dispatches with a valid authenticated payload', async () => {
    const { createApp } = await import('../src/api/app.js');
    const app = createApp(testSettings());

    const res = await request(app)
      .post('/calls/property-availability')
      .set('x-api-key', 'test-secret')
      .send({
        owner_name: 'Ramesh',
        phone_number: '+919876543210',
        property_id: 'P1',
        property_address: '42 Indiranagar',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dispatched');
    expect(mockSecureDispatch).toHaveBeenCalledOnce();
  });

  it('returns 409 when the secure dispatcher reports a conflict', async () => {
    mockSecureDispatch.mockResolvedValueOnce({
      ok: false,
      failure: {
        kind: 'conflict',
        status: 409,
        error: 'A call for this property and phone number is already active',
        existingJobId: 'job-existing',
        existingStatus: 'in_progress',
      },
    });

    const { createApp } = await import('../src/api/app.js');
    const app = createApp(testSettings());

    const res = await request(app)
      .post('/calls/property-availability')
      .set('Authorization', 'Bearer test-secret')
      .send({
        owner_name: 'Ramesh',
        phone_number: '+919876543210',
        property_id: 'P1',
        property_address: '42 Indiranagar',
      });

    expect(res.status).toBe(409);
    expect(res.body.existingJobId).toBe('job-existing');
  });

  it('returns 403 when compliance blocks the call', async () => {
    mockSecureDispatch.mockResolvedValueOnce({
      ok: false,
      failure: {
        kind: 'compliance',
        status: 403,
        error: 'Phone number is marked DND',
        reason: 'dnd',
      },
    });

    const { createApp } = await import('../src/api/app.js');
    const app = createApp(testSettings());

    const res = await request(app)
      .post('/calls/property-availability')
      .set('Authorization', 'Bearer test-secret')
      .send({
        owner_name: 'Ramesh',
        phone_number: '+919876543210',
        property_id: 'P1',
        property_address: '42 Indiranagar',
      });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('dnd');
  });

  it('returns 503 when the database lock path is unavailable', async () => {
    mockSecureDispatch.mockResolvedValueOnce({
      ok: false,
      failure: {
        kind: 'database_required',
        status: 503,
        error: 'DATABASE_URL is required for outbound dispatch',
      },
    });

    const { createApp } = await import('../src/api/app.js');
    const app = createApp(testSettings());

    const res = await request(app)
      .post('/calls/property-availability')
      .set('Authorization', 'Bearer test-secret')
      .send({
        owner_name: 'Ramesh',
        phone_number: '+919876543210',
        property_id: 'P1',
        property_address: '42 Indiranagar',
      });

    expect(res.status).toBe(503);
  });

  it('rate limits POST /calls/property-availability', async () => {
    const { createApp } = await import('../src/api/app.js');
    const app = createApp(testSettings(), { writeRateLimitMax: 2 });

    const payload = {
      owner_name: 'Ramesh',
      phone_number: '+919876543210',
      property_id: 'P1',
      property_address: '42 Indiranagar',
    };

    const post = () =>
      request(app)
        .post('/calls/property-availability')
        .set('Authorization', 'Bearer test-secret')
        .send(payload);

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);

    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('Too many requests');
    expect(limited.headers['ratelimit-limit']).toBe('2');
  });

  it('rate limits GET /calls/results', async () => {
    const { createApp } = await import('../src/api/app.js');
    const app = createApp(testSettings(), { readRateLimitMax: 2 });

    const get = () =>
      request(app)
        .get('/calls/results')
        .set('Authorization', 'Bearer test-secret');

    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);

    const limited = await get();
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('Too many requests');
  });
});
