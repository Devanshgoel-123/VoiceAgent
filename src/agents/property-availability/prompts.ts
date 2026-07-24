export interface PropertyPromptParams {
  companyName: string;
  callerName: string;
  propertyAddress: string;
  propertyType?: string;
  bhk?: string;
  rentAmount?: number;
  city?: string;
}

/**
 * Fallback LLM instructions — only used when the owner's speech is unclear
 * (not a clear yes/no). Opening and closing are scripted TTS.
 */
export function buildPropertyAvailabilityInstructions(
  params: PropertyPromptParams,
): string {
  const propertyDesc = formatProperty(params);

  return `
You are ${params.callerName} from ${params.companyName} on a short outbound property call.

The system already played the opening and will play the closing. You only handle UNCLEAR owner speech.

PROPERTY:
${propertyDesc}

WHEN YOU ARE INVOKED:
- The owner did not give a clear yes/no. Ask once, briefly, whether the property is still available for rent.
- Reply in the same language they used (English, Hindi, or Kannada).
- Keep it to one short sentence.
- If they ask a direct question about the property (rent, BHK, address, city, type), answer briefly using ONLY the property details above, then steer back to availability.
- If they ask something unrelated to this call, say you cannot help with that and suggest visiting gullynest.com to reach the team, then return to the availability question.
- If they clearly answer yes or no, call recordPropertyAvailability.
- After that tool, do NOT speak — the system plays the closing.
- If they switch language with a full sentence, call switchConversationLanguage once.
- Never use the owner's name, "Sir", or "Madam".
- Never invent a goodbye.
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
  parts.push(`- Listed by: ${params.companyName} (${params.callerName} is calling on their behalf)`);
  return parts.join('\n');
}
