import type { LanguageCode } from '../core/language-manager.js';
import type { TtsProvider } from '../config/settings.js';

/**
 * Opaque pipeline components accepted by AgentSession.
 * Kept loosely typed to avoid brittle deep imports into @livekit/agents internals.
 */
export interface VoicePipelineBundle {
  stt: unknown;
  llm: unknown;
  tts: unknown;
  ttsProvider: TtsProvider;
}

export interface VoicePipelineOptions {
  /** Prefer telephony codecs when the provider supports them. */
  telephony?: boolean;
  language?: LanguageCode;
  /** Per-call override; otherwise use TTS_PROVIDER from environment. */
  ttsProvider?: TtsProvider;
}

export interface VoicePipelineProvider {
  createBundle(options?: VoicePipelineOptions): VoicePipelineBundle;
}
