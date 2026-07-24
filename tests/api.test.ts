import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Settings } from '../src/config/settings.js';

const mockDispatch = vi.fn(async () => ({
  jobId: 'job-1',
  status: 'dispatched' as const,
  roomName: 'room-1',
  dispatchId: 'dispatch-1',
  agentName: 'test-agent',
  phoneNumber: '+919876543210',
}));

vi.mock('../src/jobs/dispatcher.js', () => ({
  CallJobDispatcher: vi.fn().mockImplementation(() => ({
    dispatchPropertyAvailabilityCall: mockDispatch,
  })),
}));

vi.mock('../src/db/call-log-repository.js', () => ({
  isDatabaseEnabled: () => false,
  safeFindBlockingDispatch: vi.fn(async () => null),
  safeUpsertDispatched: vi.fn(async () => undefined),
  getCallLogRepository: vi.fn(),
}));

vi.mock('../src/jobs/suppression.js', () => ({
  isPhoneSuppressed: vi.fn(async () => false),
}));

function testSettings(): Settings {
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
    callerName: 'Aditi',
    llmModel: 'sarvam-105b',
    defaultLanguage: 'en-IN',
    telephonySampleRate: 8000,
    dispatchCooldownMs: 86_400_000,
    appEnv: 'developer',
    callDebugLogging: false,
  };
}

describe('API server', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
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
    expect(mockDispatch).toHaveBeenCalledOnce();
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
