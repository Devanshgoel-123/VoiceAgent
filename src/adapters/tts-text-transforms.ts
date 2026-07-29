import { ReadableStream } from 'node:stream/web';
import type { LanguageCode } from '../core/language-manager.js';

const TOOL_CALL_START = '<tool_call>';
const TOOL_CALL_END = '</tool_call>';

/**
 * Remove model control markup before text reaches TTS.
 * Keeps a short suffix buffered so tags split across stream chunks are caught.
 */
export function filterToolCallMarkup(
  input: ReadableStream<string>,
): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      const reader = input.getReader();
      let buffer = '';
      let insideToolCall = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;

          while (buffer) {
            const lower = buffer.toLowerCase();
            if (insideToolCall) {
              const end = lower.indexOf(TOOL_CALL_END);
              if (end < 0) {
                buffer = buffer.slice(-(TOOL_CALL_END.length - 1));
                break;
              }
              buffer = buffer.slice(end + TOOL_CALL_END.length);
              insideToolCall = false;
              continue;
            }

            const start = lower.indexOf(TOOL_CALL_START);
            if (start >= 0) {
              if (start > 0) controller.enqueue(buffer.slice(0, start));
              buffer = buffer.slice(start + TOOL_CALL_START.length);
              insideToolCall = true;
              continue;
            }

            const safeLength = buffer.length - (TOOL_CALL_START.length - 1);
            if (safeLength <= 0) break;
            controller.enqueue(buffer.slice(0, safeLength));
            buffer = buffer.slice(safeLength);
          }
        }

        if (!insideToolCall && buffer && !/^<tool(?:_call)?/i.test(buffer)) {
          controller.enqueue(buffer);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

const LANGUAGE_FALLBACKS: Record<Exclude<LanguageCode, 'unknown'>, string> = {
  'en-IN':
    'Sorry, I had trouble generating that response. Please repeat your question in English, Hindi, or Kannada.',
  'hi-IN':
    'क्षमा कीजिए, उत्तर तैयार करने में समस्या हुई। कृपया अपना प्रश्न हिंदी, अंग्रेज़ी या कन्नड़ में दोबारा पूछें।',
  'kn-IN':
    'ಕ್ಷಮಿಸಿ, ಉತ್ತರವನ್ನು ಸಿದ್ಧಪಡಿಸುವಲ್ಲಿ ಸಮಸ್ಯೆಯಾಯಿತು. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಕನ್ನಡ, ಇಂಗ್ಲಿಷ್ ಅಥವಾ ಹಿಂದಿಯಲ್ಲಿ ಮತ್ತೆ ಕೇಳಿ.',
};

function characterMatchesLanguage(
  character: string,
  language: Exclude<LanguageCode, 'unknown'>,
): boolean {
  if (!/\p{L}/u.test(character)) return true;
  if (/\p{Script=Latin}/u.test(character)) return true;
  if (language === 'hi-IN' && /\p{Script=Devanagari}/u.test(character)) return true;
  if (language === 'kn-IN' && /\p{Script=Kannada}/u.test(character)) return true;
  return false;
}

/**
 * Last-resort speech boundary: never send text in a language other than the
 * selected English, Hindi, or Kannada voice to TTS. The full short response is
 * buffered so no unsupported prefix can be spoken before it is validated.
 */
export function enforceSelectedSpeechLanguage(
  input: ReadableStream<string>,
  getLanguage: () => LanguageCode,
): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      const reader = input.getReader();
      let text = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += value;
        }

        const selected = getLanguage();
        const language = selected === 'unknown' ? 'en-IN' : selected;
        const valid = [...text].every((character) =>
          characterMatchesLanguage(character, language),
        );
        controller.enqueue(valid ? text : LANGUAGE_FALLBACKS[language]);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
