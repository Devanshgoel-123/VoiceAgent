import type { AudioFrame } from '@livekit/rtc-node';

/**
 * Scale PCM Int16 samples in-place.
 * gain 1.0 = unchanged; 0.65 ≈ noticeably quieter on phone.
 */
export function applyTtsVolumeGain(frame: AudioFrame, gain: number): AudioFrame {
  if (!Number.isFinite(gain) || gain >= 0.999) {
    return frame;
  }
  const clamped = Math.min(1, Math.max(0.1, gain));
  const data = frame.data;
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.max(-32768, Math.min(32767, Math.round(data[i]! * clamped)));
  }
  return frame;
}

type SynthesizeFn = (...args: never[]) => unknown;

/**
 * Patch a LiveKit TTS instance so every synthesize() audio frame is quieter.
 * Works for HTTP ChunkedStream path used by ElevenLabs StreamAdapter.
 */
export function withTtsVolumeGain<T extends { synthesize: SynthesizeFn }>(
  ttsInstance: T,
  gain: number,
): T {
  if (!Number.isFinite(gain) || gain >= 0.999) {
    return ttsInstance;
  }

  const originalSynthesize = ttsInstance.synthesize.bind(ttsInstance) as (
    ...args: unknown[]
  ) => AsyncIterable<unknown> & Record<string, unknown>;

  ttsInstance.synthesize = ((...args: unknown[]) => {
    const stream = originalSynthesize(...args);
    return wrapChunkedStream(stream, gain);
  }) as T['synthesize'];

  return ttsInstance;
}

function wrapChunkedStream<S extends AsyncIterable<unknown> & Record<string, unknown>>(
  stream: S,
  gain: number,
): S {
  const originalIterator = stream[Symbol.asyncIterator].bind(stream);

  Object.defineProperty(stream, Symbol.asyncIterator, {
    configurable: true,
    value: async function* () {
      const iterator = originalIterator();
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          return next.value;
        }
        const packet = next.value;
        if (
          packet &&
          typeof packet === 'object' &&
          'frame' in packet &&
          (packet as { frame: AudioFrame }).frame?.data
        ) {
          applyTtsVolumeGain((packet as { frame: AudioFrame }).frame, gain);
        }
        yield packet;
      }
    },
  });

  return stream;
}
