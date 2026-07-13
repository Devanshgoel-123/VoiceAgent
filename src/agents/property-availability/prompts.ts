import type { LanguageCode } from '../../core/language-manager.js';

export interface PropertyPromptParams {
  companyName: string;
  ownerName: string;
  propertyAddress: string;
  propertyType?: string;
  bhk?: string;
  rentAmount?: number;
  city?: string;
}

/** Fixed opening line used when the owner stays silent / first speaks (no LLM delay). */
export function buildOpeningGreeting(
  params: PropertyPromptParams,
  language: LanguageCode = 'en-IN',
): string {
  const { companyName, ownerName, propertyAddress } = params;

  if (language === 'hi-IN') {
    return (
      `नमस्ते ${ownerName}, मैं ${companyName} से बात कर रहा हूँ। ` +
      `आपकी प्रॉपर्टी ${propertyAddress} के बारे में कॉल है। ` +
      `क्या वह अभी भी किराए पर उपलब्ध है?`
    );
  }

  if (language === 'kn-IN') {
    return (
      `ನಮಸ್ಕಾರ ${ownerName}, ನಾನು ${companyName} ನಿಂದ ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ. ` +
      `ನಿಮ್ಮ ಆಸ್ತಿ ${propertyAddress} ಬಗ್ಗೆ ಕರೆ. ` +
      `ಅದು ಇನ್ನೂ ಬಾಡಿಗೆಗೆ ಲಭ್ಯವಿದೆಯೇ?`
    );
  }

  return (
    `Hello ${ownerName}, this is ${companyName} calling about your property ` +
    `at ${propertyAddress}. Is it still available for rent?`
  );
}

export function buildPropertyAvailabilityInstructions(
  params: PropertyPromptParams,
): string {
  const propertyDesc = formatProperty(params);

  return `
You are a polite voice assistant calling on behalf of ${params.companyName}.

CALL PURPOSE:
Ask ${params.ownerName} ONE question only: is the property still available for rent?

PROPERTY DETAILS:
${propertyDesc}

CONVERSATION FLOW:
1. If the owner greets first (Hello / Haan / Namaste), briefly introduce yourself from ${params.companyName} in THEIR language and ask availability.
2. If you already introduced yourself (system opening), do not repeat the full intro — just continue naturally in their language.
3. Wait for a clear yes or no, then call recordPropertyAvailability.
4. Stop speaking. The system will thank them and hang up automatically.

RULES:
- Ask ONLY the availability question. Do not ask about visits, tenants, or anything else.
- Keep replies SHORT (one or two sentences). Latency matters.
- Always reply in the same language the owner is using (English, Hindi, or Kannada).
- If they switch languages mid-call, switch immediately and call switchConversationLanguage.
- Never use square brackets. Say "${params.companyName}" plainly.
- "Hello" and "hi" are greetings, not goodbye — keep going.
- Keep the call under 1 minute.
- After calling recordPropertyAvailability, do not speak and do not call any other tool.
`.trim();
}

function formatProperty(params: PropertyPromptParams): string {
  const parts = [`- Address: ${params.propertyAddress}`];
  if (params.city) parts.push(`- City: ${params.city}`);
  parts.push(`- Type: ${params.propertyType ?? 'rental'}`);
  if (params.bhk) parts.push(`- Configuration: ${params.bhk}`);
  if (params.rentAmount) {
    parts.push(
      `- Listed rent: ₹${params.rentAmount.toLocaleString('en-IN')}/month`,
    );
  }
  return parts.join('\n');
}
