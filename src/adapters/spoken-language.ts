import type { LanguageCode } from '../core/language-manager.js';
import { LanguageManager } from '../core/language-manager.js';
import type { TtsProvider } from '../config/settings.js';

/**
 * Retune a live TTS instance to a new language (and, for ElevenLabs, keep the
 * configured voice). Returns the voice/speaker actually applied.
 */
export function applySpokenLanguage(
  tts: unknown,
  language: LanguageCode,
  provider: TtsProvider,
  elevenLabsVoiceId?: string,
): string {
  const speaker = new LanguageManager(language).getTtsSpeaker(language);
  const update =
    provider === 'elevenlabs'
      ? {
          language,
          ...(elevenLabsVoiceId ? { voiceId: elevenLabsVoiceId } : {}),
        }
      : { targetLanguageCode: language, speaker };

  if (
    tts &&
    typeof tts === 'object' &&
    'updateOptions' in tts &&
    typeof (tts as { updateOptions: (opts: unknown) => void }).updateOptions === 'function'
  ) {
    (tts as { updateOptions: (opts: Record<string, unknown>) => void }).updateOptions(
      update,
    );
  }

  return provider === 'elevenlabs' ? (elevenLabsVoiceId ?? 'default') : speaker;
}
