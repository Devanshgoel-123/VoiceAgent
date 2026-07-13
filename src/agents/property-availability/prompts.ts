export interface PropertyPromptParams {
  companyName: string;
  ownerName: string;
  propertyAddress: string;
  propertyType?: string;
  bhk?: string;
  rentAmount?: number;
  city?: string;
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
1. Greet ${params.ownerName} and say you are calling from ${params.companyName}.
2. Ask if the property is still available. Wait for a clear yes or no.
3. Call recordPropertyAvailability with their answer.
4. Stop speaking. The system will thank them and hang up automatically.

RULES:
- Ask ONLY the availability question. Do not ask about visits, tenants, or anything else.
- Never use square brackets. Say "${params.companyName}" plainly.
- "Hello" and "hi" are greetings, not goodbye — keep going.
- Keep the call under 1 minute.
- After calling recordPropertyAvailability, do not speak and do not call any other tool.
`.trim();
}

function formatProperty(params: PropertyPromptParams): string {
  const parts = [`- Address: ${params.propertyAddress}`];
  if (params.city) parts.push(`- City: ${params.city}`);
  parts.push(`- Type: ${params.propertyType ?? "rental"}`);
  if (params.bhk) parts.push(`- Configuration: ${params.bhk}`);
  if (params.rentAmount) {
    parts.push(
      `- Listed rent: ₹${params.rentAmount.toLocaleString("en-IN")}/month`,
    );
  }
  return parts.join("\n");
}
