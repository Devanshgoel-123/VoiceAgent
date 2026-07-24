import { callError } from './call-logger.js';

let registered = false;

/** Last-resort handlers so one bad call does not crash the worker without logging. */
export function registerProcessSafetyHandlers(scope: 'worker' | 'api'): void {
  if (registered) return;
  registered = true;

  process.on('unhandledRejection', (reason) => {
    callError(`[${scope}] unhandledRejection: ${reason}`);
  });

  process.on('uncaughtException', (error) => {
    callError(`[${scope}] uncaughtException: ${error}`);
    process.exit(1);
  });
}

/** Wrap fire-and-forget async work with logging instead of silent rejection. */
export function fireAndForget(
  label: string,
  work: () => Promise<void>,
  logger?: { error: (msg: string) => void },
): void {
  void work().catch((error) => {
    const message = `${label}: ${error}`;
    if (logger) {
      logger.error(message);
    } else {
      callError(message);
    }
  });
}
