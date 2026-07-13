import type { LanguageCode } from '../core/language-manager.js';

/**
 * Opaque pipeline components accepted by AgentSession.
 * Kept loosely typed to avoid brittle deep imports into @livekit/agents internals.
 */
export interface VoicePipelineBundle {
  stt: unknown;
  llm: unknown;
  tts: unknown;
}

export interface VoicePipelineOptions {
  /** Prefer telephony codecs when the provider supports them. */
  telephony?: boolean;
  language?: LanguageCode;
}

export interface VoicePipelineProvider {
  createBundle(options?: VoicePipelineOptions): VoicePipelineBundle;
}
