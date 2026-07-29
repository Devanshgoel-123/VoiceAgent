import { ReadableStream } from 'node:stream/web';

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
