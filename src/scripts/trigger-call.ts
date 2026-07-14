#!/usr/bin/env node
import 'dotenv/config';
import { getSettings } from '../config/settings.js';
import { CallJobDispatcher } from '../jobs/dispatcher.js';
import { createPropertyAvailabilityJob } from '../jobs/models.js';

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const ownerName = args.owner_name;
  const phone = args.phone;
  const propertyId = args.property_id;
  const address = args.address;

  if (!ownerName || !phone || !propertyId || !address) {
    console.error(
      'Usage: npm run trigger:call -- --owner-name "Name" --phone "+91..." --property-id "ID" --address "Address" [--bhk "2 BHK"] [--rent 25000] [--city Bangalore] [--language en-IN|hi-IN|kn-IN] [--tts-provider sarvam|elevenlabs]',
    );
    process.exit(1);
  }

  const settings = getSettings();
  const job = createPropertyAvailabilityJob({
    owner: { name: ownerName, phoneNumber: phone },
    property: {
      propertyId,
      address,
      bhk: args.bhk,
      rentAmount: args.rent ? Number(args.rent) : undefined,
      city: args.city,
      propertyType: args.property_type,
    },
    companyName: settings.companyName,
    preferredLanguage: args.language,
    metadata:
      args.tts_provider === 'sarvam' || args.tts_provider === 'elevenlabs'
        ? { tts_provider: args.tts_provider }
        : {},
  });

  const dispatcher = new CallJobDispatcher(settings);
  const result = await dispatcher.dispatchPropertyAvailabilityCall(job);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Failed to trigger call:', err);
  process.exit(1);
});
