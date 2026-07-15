import 'dotenv/config';

export type TtsProvider = 'sarvam' | 'elevenlabs';
export type ElevenLabsTransport = 'http' | 'websocket';

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
  companyName: string;
  callerName: string;
  databaseUrl?: string;
  llmModel: string;
  defaultLanguage: string;
  telephonySampleRate: number;
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

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing required environment variable: ${key}`);
    return value;
  };

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
    sipOutboundTrunkId: process.env.SIP_OUTBOUND_TRUNK_ID ?? '',
    agentName: process.env.AGENT_NAME ?? 'gully-property-availability-agent',
    apiHost: process.env.API_HOST ?? '0.0.0.0',
    apiPort: Number(process.env.API_PORT ?? '8080'),
    companyName: process.env.COMPANY_NAME ?? 'Galynest',
    callerName: process.env.CALLER_NAME?.trim() || 'Aditi',
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
    llmModel: 'sarvam-105b',
    defaultLanguage: 'en-IN',
    telephonySampleRate: 8000,
  };

  return cachedSettings;
}
