import 'dotenv/config';

export type AppEnv = 'developer' | 'production';

export interface Settings {
  /** `developer` enables verbose [CALL] stage logs; `production` keeps warn/error only. */
  appEnv: AppEnv;
  /** Explicit override for stage logging. Defaults to true in developer, false in production. */
  callDebugLogging: boolean;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  sarvamApiKey: string;
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
