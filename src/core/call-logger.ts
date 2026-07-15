import { log } from '@livekit/agents';

type LiveKitLogger = ReturnType<typeof log>;

function resolveLogger(logger?: LiveKitLogger): LiveKitLogger | Console {
  if (logger) return logger;
  try {
    return log();
  } catch {
    return console;
  }
}

function parseAppEnv(raw: string | undefined): 'developer' | 'production' {
  const value = (raw ?? 'developer').trim().toLowerCase();
  if (value === 'production' || value === 'prod') return 'production';
  return 'developer';
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

/** True when APP_ENV=developer (default). */
export function isDeveloperEnv(): boolean {
  return parseAppEnv(process.env.APP_ENV) === 'developer';
}

/**
 * Verbose [CALL] stage tracing.
 * On when APP_ENV=developer, or when CALL_DEBUG_LOGGING=true overrides.
 * Off in production unless CALL_DEBUG_LOGGING=true.
 */
export function isCallDebugEnabled(): boolean {
  return parseBool(process.env.CALL_DEBUG_LOGGING, isDeveloperEnv());
}

/**
 * Verbose stage / flow tracing — intentionally a no-op.
 * We deliberately keep only concise transcript, agent-state, and
 * language-change logs. This stays as a no-op so the many existing call sites
 * don't need to be touched (and can be re-enabled here if ever needed).
 */
export function callDebug(_message: string, _logger?: LiveKitLogger): void {
  // no-op: verbose call tracing removed to keep logs minimal.
}

/** Always emitted — use sparingly for rare milestones. */
export function callInfo(message: string, logger?: LiveKitLogger): void {
  resolveLogger(logger).info(message);
}

/** Always emitted. */
export function callWarn(message: string, logger?: LiveKitLogger): void {
  resolveLogger(logger).warn(message);
}

/** Always emitted. */
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
