/** E.164 (e.g. +919876543210): the only format we dial, suppress, or dedupe on. */
export const E164_PHONE_RE = /^\+[1-9]\d{7,14}$/;

export function isE164Phone(phoneNumber: string): boolean {
  return E164_PHONE_RE.test(phoneNumber);
}
