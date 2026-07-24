import { log } from '@livekit/agents';
import { isVerboseCallLogging } from '../config/settings.js';

type LiveKitLogger = ReturnType<typeof log>;

function resolveLogger(logger?: LiveKitLogger): LiveKitLogger | Console {
  if (logger) return logger;
  try {
    return log();
  } catch {
    return console;
  }
}

/** Transcript lines, agent state, and language switches. */
export function callInfo(message: string, logger?: LiveKitLogger): void {
  resolveLogger(logger).info(message);
}

/** Verbose owner/agent turn text — gated by APP_ENV / CALL_DEBUG_LOGGING. */
export function callDebug(message: string, logger?: LiveKitLogger): void {
  if (!isVerboseCallLogging()) return;
  resolveLogger(logger).info(message);
}

export function callWarn(message: string, logger?: LiveKitLogger): void {
  resolveLogger(logger).warn(message);
}

export function callError(
  message: string,
  logger?: LiveKitLogger,
  extra?: Record<string, unknown>,
): void {
  const sink = resolveLogger(logger);
  if (extra && typeof (sink as LiveKitLogger).error === 'function') {
    try {
      (sink as LiveKitLogger).error(extra, message);
      return;
    } catch {
      // fall through
    }
  }
  sink.error(message);
}
