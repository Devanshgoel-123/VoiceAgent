import type { LanguageCode } from '../core/language-manager.js';
import { LanguageManager } from '../core/language-manager.js';
import { callDebug } from '../core/call-logger.js';
import type { TtsProvider } from '../config/settings.js';

/**
 * Point Sarvam TTS at a new language + matching speaker.
 * Layman: changes the agent's "mouth" so Hindi text is spoken as Hindi, etc.
 */
export function applySpokenLanguage(
  tts: unknown,
  language: LanguageCode,
  provider: TtsProvider,
): string {
  const speaker = new LanguageManager(language).getTtsSpeaker(language);
  const update =
    provider === 'elevenlabs'
      ? { language }
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
    callDebug(
      `[CALL] pipeline.language:tts_updated provider=${provider} language=${language} voice=${provider === 'elevenlabs' ? 'configured voice' : speaker}`,
    );
  } else {
    callDebug(
      `[CALL] pipeline.language:tts_update_skipped language=${language} (no updateOptions)`,
    );
  }

  return provider === 'elevenlabs' ? 'configured voice' : speaker;
}
