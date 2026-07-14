import 'dotenv/config';

export type AppEnv = 'developer' | 'production';
export type TtsProvider = 'sarvam' | 'elevenlabs';
export type ElevenLabsTransport = 'http' | 'websocket';

export interface Settings {
  /** `developer` enables verbose [CALL] stage logs; `production` keeps warn/error only. */
  appEnv: AppEnv;
  /** Explicit override for stage logging. Defaults to true in developer, false in production. */
  callDebugLogging: boolean;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  sarvamApiKey: string;
  /** Which company generates agent speech. STT/LLM remain on Sarvam. */
  ttsProvider: TtsProvider;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModel: string;
  elevenLabsTransport: ElevenLabsTransport;
  sipOutboundTrunkId: string;
  agentName: string;
  apiHost: string;
  apiPort: number;
  companyName: string;
  sttModel: string;
  llmModel: string;
  ttsModel: string;
  defaultTtsSpeaker: string;
  defaultLanguage: string;
  telephonyAudioCodec: string;
  telephonySampleRate: number;
}

function parseAppEnv(raw: string | undefined): AppEnv {
  const value = (raw ?? 'developer').trim().toLowerCase();
  if (value === 'production' || value === 'prod') return 'production';
  return 'developer';
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
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

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing required environment variable: ${key}`);
    return value;
  };

  const appEnv = parseAppEnv(process.env.APP_ENV);
  cachedSettings = {
    appEnv,
    callDebugLogging: parseBool(
      process.env.CALL_DEBUG_LOGGING,
      appEnv === 'developer',
    ),
    livekitUrl: required('LIVEKIT_URL'),
    livekitApiKey: required('LIVEKIT_API_KEY'),
    livekitApiSecret: required('LIVEKIT_API_SECRET'),
    sarvamApiKey: required('SARVAM_API_KEY'),
    ttsProvider: parseTtsProvider(process.env.TTS_PROVIDER),
    elevenLabsApiKey: process.env.ELEVEN_API_KEY,
    elevenLabsVoiceId: optionalRealValue(process.env.ELEVENLABS_VOICE_ID),
    elevenLabsModel:
      process.env.ELEVENLABS_MODEL ?? 'eleven_v3',
    elevenLabsTransport: parseElevenLabsTransport(
      process.env.ELEVENLABS_TRANSPORT,
    ),
    sipOutboundTrunkId: process.env.SIP_OUTBOUND_TRUNK_ID ?? '',
    agentName: process.env.AGENT_NAME ?? 'gully-property-availability-agent',
    apiHost: process.env.API_HOST ?? '0.0.0.0',
    apiPort: Number(process.env.API_PORT ?? '8080'),
    companyName: process.env.COMPANY_NAME ?? 'Gullynest',
    sttModel: 'saaras:v3',
    llmModel: 'sarvam-105b',
    ttsModel: 'bulbul:v3',
    defaultTtsSpeaker: 'aditya',
    defaultLanguage: 'en-IN',
    telephonyAudioCodec: 'mulaw',
    telephonySampleRate: 8000,
  };

  return cachedSettings;
}

export function resetSettingsCache(): void {
  cachedSettings = null;
}
