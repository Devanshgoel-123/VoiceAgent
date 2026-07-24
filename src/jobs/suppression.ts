import { callWarn } from '../core/call-logger.js';
import { getCallLogRepository, isDatabaseEnabled } from '../db/call-log-repository.js';

export async function isPhoneSuppressed(phoneNumber: string): Promise<boolean> {
  if (!isDatabaseEnabled()) return false;
  try {
    return await getCallLogRepository().isPhoneSuppressed(phoneNumber);
  } catch (error) {
    callWarn(`[CALL] suppression.check_fail phone=${phoneNumber} error=${error}`);
    // Fail closed for suppression checks when DB is configured but errors.
    throw error;
  }
}

export async function safeAddPhoneSuppression(
  phoneNumber: string,
  reason: string,
): Promise<void> {
  if (!isDatabaseEnabled()) return;
  try {
    await getCallLogRepository().addPhoneSuppression(phoneNumber, reason);
  } catch (error) {
    callWarn(`[CALL] suppression.add_fail phone=${phoneNumber} error=${error}`);
  }
}
