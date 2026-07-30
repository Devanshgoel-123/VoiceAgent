import 'dotenv/config';
import {
  DEFAULT_DISPATCH_COOLDOWN_MS,
  DEFAULT_DISPATCH_SPACING_MS,
} from './call-config.js';

export type TtsProvider = 'sarvam' | 'elevenlabs';
export type ElevenLabsTransport = 'http' | 'websocket';
export type AppEnv = 'developer' | 'production';
export type SupportedLanguage = 'en-IN' | 'hi-IN' | 'kn-IN';

export interface Settings {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  sarvamApiKey: string;
  /** One Sarvam voice identity reused across every supported language. */
  sarvamTtsSpeaker?: string;
  ttsProvider: TtsProvider;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModel: string;
  elevenLabsTransport: ElevenLabsTransport;
  ttsVolume: number;
  ttsSpeed: number;
  sipOutboundTrunkId: string;
  agentName: string;
  apiHost: string;
  apiPort: number;
  apiSecretKey: string;
  companyName: string;
  companyWebsite: string;
  callerName: string;
  databaseUrl?: string;
  llmModel: string;
  defaultLanguage: SupportedLanguage;
  telephonySampleRate: number;
  dispatchCooldownMs: number;
  /**
   * Pause between consecutive outbound dials in a voice-cron batch.
   * Protects SIP trunk rate limits (e.g. Vobiz). Set 0 to disable.
   */
  dispatchSpacingMs: number;
  callingHoursStartHour: number;
  callingHoursEndHour: number;
  callingHoursTimeZone: string;
  /** Days to retain verbatim transcripts in Postgres (default 15). */
  callDataRetentionDays: number;
  /** Per-IP limit for GET /calls/results* (per minute). */
  apiReadRateLimitPerMinute: number;
  /** Per-IP limit for POST /suppressed-numbers (per minute). */
  apiSuppressionWriteRateLimitPerMinute: number;
  /** GullyNest marketplace base URL (optional; enables voice cron + outcome PATCH). */
  voiceAgentApiBaseUrl?: string;
  /** Shared secret for `X-Voice-Admin-Secret` (optional). */
  voiceAgentApiSecret?: string;
  /** Ms between cron ticks (default 15 minutes). */
  voiceCronIntervalMs: number;
  appEnv: AppEnv;
  callDebugLogging: boolean;
}

function parseTtsProvider(raw: string | undefined): TtsProvider {
  return raw?.trim().toLowerCase() === 'elevenlabs' ? 'elevenlabs' : 'sarvam';
}

function optionalRealValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || value === 'your_voice_id' || value.startsWith('your_')) {
    return undefined;
  }
  return value;
}

function parseElevenLabsTransport(
  raw: string | undefined,
): ElevenLabsTransport {
  return raw?.trim().toLowerCase() === 'websocket' ? 'websocket' : 'http';
}

function parseTtsVolume(raw: string | undefined): number {
  const parsed = Number(raw ?? '1.15');
  if (!Number.isFinite(parsed)) return 1.15;
  return Math.min(2, Math.max(0.1, parsed));
}

function parseTtsSpeed(raw: string | undefined): number {
  const parsed = Number(raw ?? '0.8');
  if (!Number.isFinite(parsed)) return 0.8;
  return Math.min(2, Math.max(0.5, parsed));
}

function parseAppEnv(raw: string | undefined): AppEnv {
  return raw?.trim().toLowerCase() === 'production' ? 'production' : 'developer';
}

function parseSupportedLanguage(raw: string | undefined): SupportedLanguage {
  const value = raw?.trim() || 'en-IN';
  if (value === 'en-IN' || value === 'hi-IN' || value === 'kn-IN') return value;
  throw new Error(
    `DEFAULT_LANGUAGE must be en-IN, hi-IN, or kn-IN; received ${JSON.stringify(value)}`,
  );
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  return undefined;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** Like parsePositiveInt but allows 0 (used to disable spacing in tests/dev). */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing required environment variable: ${key}`);
    return value;
  };

  const appEnv = parseAppEnv(process.env.APP_ENV);
  const callDebugLogging =
    parseBoolean(process.env.CALL_DEBUG_LOGGING) ?? appEnv === 'developer';

  cachedSettings = {
    livekitUrl: required('LIVEKIT_URL'),
    livekitApiKey: required('LIVEKIT_API_KEY'),
    livekitApiSecret: required('LIVEKIT_API_SECRET'),
    sarvamApiKey: required('SARVAM_API_KEY'),
    sarvamTtsSpeaker: process.env.SARVAM_TTS_SPEAKER?.trim() || 'aditya',
    ttsProvider: parseTtsProvider(process.env.TTS_PROVIDER),
    elevenLabsApiKey: process.env.ELEVEN_API_KEY,
    elevenLabsVoiceId: optionalRealValue(process.env.ELEVENLABS_VOICE_ID),
    elevenLabsModel: process.env.ELEVENLABS_MODEL ?? 'eleven_v3',
    elevenLabsTransport: parseElevenLabsTransport(process.env.ELEVENLABS_TRANSPORT),
    ttsVolume: parseTtsVolume(process.env.TTS_VOLUME),
    ttsSpeed: parseTtsSpeed(process.env.TTS_SPEED),
    sipOutboundTrunkId: required('SIP_OUTBOUND_TRUNK_ID'),
    agentName: process.env.AGENT_NAME ?? 'gully-property-availability-agent',
    apiHost: process.env.API_HOST ?? '0.0.0.0',
    apiPort: Number(process.env.API_PORT ?? '8080'),
    apiSecretKey: required('API_SECRET_KEY'),
    companyName: process.env.COMPANY_NAME?.trim() || 'Galynest',
    companyWebsite:
      process.env.COMPANY_WEBSITE?.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '') ||
      'galynest.com',
    callerName: process.env.CALLER_NAME?.trim() || 'Aditi',
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
    llmModel: process.env.LLM_MODEL ?? 'sarvam-105b',
    defaultLanguage: parseSupportedLanguage(process.env.DEFAULT_LANGUAGE),
    telephonySampleRate: parsePositiveInt(process.env.TELEPHONY_SAMPLE_RATE, 8000),
    dispatchCooldownMs: parsePositiveInt(
      process.env.DISPATCH_COOLDOWN_MS,
      DEFAULT_DISPATCH_COOLDOWN_MS,
    ),
    dispatchSpacingMs: parseNonNegativeInt(
      process.env.DISPATCH_SPACING_MS,
      DEFAULT_DISPATCH_SPACING_MS,
    ),
    callingHoursStartHour: parsePositiveInt(process.env.CALLING_HOURS_START_HOUR, 9),
    callingHoursEndHour: parsePositiveInt(process.env.CALLING_HOURS_END_HOUR, 20),
    callingHoursTimeZone: process.env.CALLING_HOURS_TZ?.trim() || 'Asia/Kolkata',
    callDataRetentionDays: parsePositiveInt(process.env.CALL_DATA_RETENTION_DAYS, 15),
    apiReadRateLimitPerMinute: parsePositiveInt(
      process.env.API_READ_RATE_LIMIT_PER_MINUTE,
      60,
    ),
    apiSuppressionWriteRateLimitPerMinute: parsePositiveInt(
      process.env.API_SUPPRESSION_WRITE_RATE_LIMIT_PER_MINUTE,
      10,
    ),
    voiceAgentApiBaseUrl: process.env.VOICE_AGENT_API_BASE_URL?.trim() || undefined,
    voiceAgentApiSecret: process.env.VOICE_AGENT_API_SECRET?.trim() || undefined,
    voiceCronIntervalMs: parsePositiveInt(
      process.env.VOICE_CRON_INTERVAL_MS,
      15 * 60 * 1000,
    ),
    appEnv,
    callDebugLogging,
  };

  return cachedSettings;
}

/** Whether verbose transcript / turn logging should be emitted. */
export function isVerboseCallLogging(): boolean {
  return getSettings().callDebugLogging;
}
