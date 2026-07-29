import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  enforceSelectedSpeechLanguage,
  filterToolCallMarkup,
  normalizeSpeechText,
} from '../src/adapters/tts-text-transforms.js';

function chunked(...chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return result;
    result += value;
  }
}

describe('filterToolCallMarkup', () => {
  it('removes a tool call split across streaming chunks', async () => {
    const output = await collect(
      filterToolCallMarkup(
        chunked(
          'Before. <tool_',
          'call>recordPropertyAvailability ',
          '<arg_value>false</arg_value></tool_',
          'call> After.',
        ),
      ),
    );

    expect(output).toBe('Before.  After.');
  });

  it('produces no speech for a tool-call-only response', async () => {
    const output = await collect(
      filterToolCallMarkup(
        chunked(
          '<tool_call>recordPropertyAvailability ',
          '<arg_value>false</arg_value></tool_call>',
        ),
      ),
    );

    expect(output).toBe('');
  });
});

describe('enforceSelectedSpeechLanguage', () => {
  it('replaces Malayalam output on an English turn before it reaches TTS', async () => {
    const output = await collect(
      enforceSelectedSpeechLanguage(
        chunked(
          'ഈ വിലാസം 42, 5th Cross, Indiranagar എന്നാണ്.',
          'ഈ പ്രോപ്പർട്ടി ഇപ്പോഴും ലഭ്യമാണോ?',
        ),
        () => 'en-IN',
      ),
    );

    expect(output).toBe(
      'Sorry, I had trouble generating that response. Please repeat your question in English, Hindi, or Kannada.',
    );
    expect(output).not.toMatch(/\p{Script=Malayalam}/u);
  });

  it('allows only the selected supported language plus Latin property details', async () => {
    await expect(
      collect(
        enforceSelectedSpeechLanguage(
          chunked('पता 42, 5th Cross, Indiranagar है।'),
          () => 'hi-IN',
        ),
      ),
    ).resolves.toBe('पता 42, 5th Cross, Indiranagar है।');

    await expect(
      collect(
        enforceSelectedSpeechLanguage(
          chunked('ವಿಳಾಸ 42, 5th Cross, Indiranagar ಆಗಿದೆ.'),
          () => 'kn-IN',
        ),
      ),
    ).resolves.toBe('ವಿಳಾಸ 42, 5th Cross, Indiranagar ಆಗಿದೆ.');
  });

  it('rejects Hindi or Kannada output when English is selected', async () => {
    const hindi = await collect(
      enforceSelectedSpeechLanguage(chunked('यह पता है।'), () => 'en-IN'),
    );
    const kannada = await collect(
      enforceSelectedSpeechLanguage(chunked('ಇದು ವಿಳಾಸ.'), () => 'en-IN'),
    );

    expect(hindi).toMatch(/^Sorry,/);
    expect(kannada).toMatch(/^Sorry,/);
  });
});

describe('normalizeSpeechText', () => {
  it('normalizes the exact malformed BHK response seen in call logs', async () => {
    const output = await collect(
      normalizeSpeechText(
        chunked(
          "It's the 2\u202fB",
          'HK in Indiranagar.',
          'Is it still available?',
        ),
      ),
    );

    expect(output).toBe(
      "It's the 2 BHK in Indiranagar. Is it still available?",
    );
  });

  it('normalizes plural BHK and address punctuation for speech', async () => {
    const output = await collect(
      normalizeSpeechText(
        chunked('I have multiple BHKs.Address: 42,5th Cross,Indiranagar.'),
      ),
    );

    expect(output).toBe(
      'I have multiple BHKs. Address: 42, 5th Cross, Indiranagar.',
    );
  });
});
