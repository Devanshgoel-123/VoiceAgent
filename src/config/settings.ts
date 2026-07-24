import 'dotenv/config';

export type TtsProvider = 'sarvam' | 'elevenlabs';
export type ElevenLabsTransport = 'http' | 'websocket';
export type AppEnv = 'developer' | 'production';

export interface Settings {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  sarvamApiKey: string;
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
  defaultLanguage: string;
  telephonySampleRate: number;
  dispatchCooldownMs: number;
  callingHoursStartHour: number;
  callingHoursEndHour: number;
  callingHoursTimeZone: string;
  /** Days to retain verbatim transcripts in Postgres (default 15). */
  callDataRetentionDays: number;
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
  const parsed = Number(raw ?? '0.65');
  if (!Number.isFinite(parsed)) return 0.65;
  return Math.min(1, Math.max(0.1, parsed));
}

function parseTtsSpeed(raw: string | undefined): number {
  const parsed = Number(raw ?? '0.8');
  if (!Number.isFinite(parsed)) return 0.8;
  return Math.min(2, Math.max(0.5, parsed));
}

function parseAppEnv(raw: string | undefined): AppEnv {
  return raw?.trim().toLowerCase() === 'production' ? 'production' : 'developer';
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
    defaultLanguage: process.env.DEFAULT_LANGUAGE ?? 'en-IN',
    telephonySampleRate: parsePositiveInt(process.env.TELEPHONY_SAMPLE_RATE, 8000),
    dispatchCooldownMs: parsePositiveInt(
      process.env.DISPATCH_COOLDOWN_MS,
      86_400_000,
    ),
    callingHoursStartHour: parsePositiveInt(process.env.CALLING_HOURS_START_HOUR, 9),
    callingHoursEndHour: parsePositiveInt(process.env.CALLING_HOURS_END_HOUR, 20),
    callingHoursTimeZone: process.env.CALLING_HOURS_TZ?.trim() || 'Asia/Kolkata',
    callDataRetentionDays: parsePositiveInt(process.env.CALL_DATA_RETENTION_DAYS, 7),
    appEnv,
    callDebugLogging,
  };

  return cachedSettings;
}

/** Whether verbose transcript / turn logging should be emitted. */
export function isVerboseCallLogging(): boolean {
  return getSettings().callDebugLogging;
}
