import type { LanguageCode } from '../../core/language-manager.js';

export interface PropertyPromptParams {
  companyName: string;
  callerName: string;
  propertyAddress: string;
  propertyType?: string;
  bhk?: string;
  rentAmount?: number;
  city?: string;
}

/** LLM instructions for the opening turn (model writes the spoken text). */
export function buildOpeningInstructions(
  params: PropertyPromptParams,
  language: LanguageCode = 'en-IN',
): string {
  const languageName =
    language === 'hi-IN' ? 'Hindi' : language === 'kn-IN' ? 'Kannada' : 'English';

  return (
    `Speak ONLY in ${languageName}. ` +
    `Start with a short greeting like "Hi", then introduce yourself as ${params.callerName} from ${params.companyName}. ` +
    `Do NOT use or invent the owner's name — never say "Sir", "Madam", or any personal name for them. ` +
    `Say the company name exactly once as "${params.companyName}" — do not transliterate it and also say it in English/parentheses. ` +
    `Say your personal name exactly once. ` +
    `Mention the property at ${params.propertyAddress}. ` +
    `Ask once whether it is still available for rent. ` +
    `Keep it to 1-2 short sentences. Do not call any tools.`
  );
}

/** LLM instructions for the outcome-specific closing (model writes the spoken text). */
export function buildClosingInstructions(
  outcome: 'yes' | 'no',
  language: LanguageCode = 'en-IN',
): string {
  const languageName =
    language === 'hi-IN' ? 'Hindi' : language === 'kn-IN' ? 'Kannada' : 'English';

  if (outcome === 'yes') {
    return (
      `Speak ONLY in ${languageName} now. This is the final closing. ` +
      `Thank them briefly. Do NOT use or invent their name. ` +
      `Say the Galinest team will continue searching for tenants, ` +
      `and that we will call them as soon as we find a tenant. ` +
      `Recommend saving this number as Galinest Property Team. Wish them a good day. ` +
      `Say company names exactly once — never as both a transliteration and English in parentheses. ` +
      `Keep it to 2-3 short sentences. Do not ask any new questions. Do not call any tools.`
    );
  }

  return (
    `Speak ONLY in ${languageName} now. This is the final closing. ` +
    `Thank them for the information. Do NOT use or invent their name. ` +
    `Say we will update our records and will not disturb them again. ` +
    `If they want a tenant later, they can visit Galinest dot com. Wish them a good day. ` +
    `Say company names exactly once — never as both a transliteration and English in parentheses. ` +
    `Keep it to 2-3 short sentences. Do not ask any new questions. Do not call any tools.`
  );
}

export function buildPropertyAvailabilityInstructions(
  params: PropertyPromptParams,
): string {
  const propertyDesc = formatProperty(params);

  return `
You are ${params.callerName}, a polite voice assistant calling from ${params.companyName}.

CALL PURPOSE:
Ask ONE question only: is the property still available for rent?

PROPERTY DETAILS:
${propertyDesc}

CONVERSATION FLOW:
1. If the owner greets first (Hello / Haan / Namaste), say Hi and introduce yourself as ${params.callerName} from ${params.companyName} in THEIR language, then ask availability.
2. Never address them by name, "Sir", or "Madam" — just speak naturally.
3. If you already introduced yourself, do not repeat the full intro — continue naturally in their language.
4. Wait for a clear yes or no, then call recordPropertyAvailability.
5. After that tool, stop. The system will ask you to speak a short closing, then hang up.

RULES:
- Ask ONLY the availability question. Do not ask about visits, tenants, or anything else.
- Keep replies SHORT (one or two sentences). Latency matters.
- Always reply in the same language the owner is using (English, Hindi, or Kannada).
- If they clearly switch languages mid-call (full sentence in a new language), switch with them and call switchConversationLanguage once.
- Do NOT switch language just because they said yes/no/haan/nahi/haudu/illa — those answers keep the current conversation language.
- Never use square brackets. Say "${params.companyName}" plainly, exactly once — do not say it as a transliteration plus English in parentheses.
- Always introduce yourself as "${params.callerName} from ${params.companyName}", never as only the company name.
- "Hello" and "hi" are greetings, not goodbye — keep going.
- Keep the call under 1 minute.
- After calling recordPropertyAvailability, do not speak until the system asks for the closing.
- Never invent your own goodbye before the closing turn.
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
