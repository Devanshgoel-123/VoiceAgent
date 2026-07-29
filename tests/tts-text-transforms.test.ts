import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { filterToolCallMarkup } from '../src/adapters/tts-text-transforms.js';

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
