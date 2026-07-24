import type { Settings } from '../config/settings.js';
import {
  createGullyNestClientFromSettings,
  type GullyNestClient,
} from '../integrations/gullynest/client.js';
import type { VoiceAdminProperty, VoicePropertyStatus } from '../integrations/gullynest/types.js';
import {
  secureDispatchPropertyAvailabilityCall,
  type SecureDispatchResult,
} from './dispatch-pipeline.js';
import { createPropertyAvailabilityJob } from './models.js';

export interface VoiceCronDispatchDeps {
  client: GullyNestClient;
  dispatch: (
    job: ReturnType<typeof createPropertyAvailabilityJob>,
    settings: Settings,
  ) => Promise<SecureDispatchResult>;
  now?: () => Date;
}

export interface VoiceCronItemResult {
  propertyId: string;
  phoneNumber?: string;
  status: 'dispatched' | 'skipped' | 'failed';
  reason?: string;
  jobId?: string;
}

export interface VoiceCronSummary {
  fetched: number;
  dispatched: number;
  skipped: number;
  failed: number;
  items: VoiceCronItemResult[];
}

function contactedBeforeIso(recontactDays: number, now: Date): string {
  const cutoff = new Date(now.getTime() - recontactDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

export function propertyToJobInput(
  property: VoiceAdminProperty,
  settings: Settings,
): Parameters<typeof createPropertyAvailabilityJob>[0] | null {
  const phone = property.listerPhone?.trim();
  const name = property.listerName?.trim() || 'Owner';
  const address = property.formattedAddress?.trim();
  if (!phone || !address) return null;

  return {
    owner: { name, phoneNumber: phone },
    property: {
      propertyId: property.id,
      address,
      bhk: property.bhk ?? undefined,
      rentAmount: property.rentMonthly ?? undefined,
      city: property.city ?? undefined,
      propertyType: property.listingUnitType || undefined,
    },
    companyName: settings.companyName,
    callerName: settings.callerName,
    preferredLanguage: settings.defaultLanguage,
    metadata: {
      source: 'gullynest_voice_cron',
      short_id: property.shortId,
      listing_kind: property.listingKind,
    },
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => run(),
  );
  await Promise.all(runners);
  return results;
}

/**
 * Fetch LIVE (or configured) properties from GullyNest and dispatch outbound calls.
 */
export async function runVoiceCron(
  settings: Settings,
  deps?: Partial<VoiceCronDispatchDeps>,
): Promise<VoiceCronSummary> {
  const client =
    deps?.client ?? createGullyNestClientFromSettings(settings);
  if (!client) {
    throw new Error(
      'VOICE_AGENT_API_BASE_URL and VOICE_AGENT_API_SECRET are required for cron:voice',
    );
  }

  const dispatch =
    deps?.dispatch ?? secureDispatchPropertyAvailabilityCall;
  const now = deps?.now?.() ?? new Date();

  const properties = await client.listAllProperties(
    {
      status: settings.voiceCronStatus as VoicePropertyStatus,
      listingKind: settings.voiceCronListingKind,
      contactedBefore: contactedBeforeIso(settings.voiceCronRecontactDays, now),
      pageSize: settings.voiceCronPageSize,
    },
    settings.voiceCronMaxDispatch * 3,
  );

  const candidates: VoiceAdminProperty[] = [];
  const skippedEarly: VoiceCronItemResult[] = [];

  for (const property of properties) {
    if (candidates.length >= settings.voiceCronMaxDispatch) break;
    const input = propertyToJobInput(property, settings);
    if (!input) {
      skippedEarly.push({
        propertyId: property.id,
        phoneNumber: property.listerPhone ?? undefined,
        status: 'skipped',
        reason: 'missing_lister_phone_or_address',
      });
      continue;
    }
    candidates.push(property);
  }

  const dispatchResults = await mapPool(
    candidates,
    settings.voiceCronConcurrency,
    async (property): Promise<VoiceCronItemResult> => {
      const input = propertyToJobInput(property, settings)!;
      const job = createPropertyAvailabilityJob(input);
      try {
        const outcome = await dispatch(job, settings);
        if (!outcome.ok) {
          return {
            propertyId: property.id,
            phoneNumber: job.owner.phoneNumber,
            status: 'failed',
            reason: `${outcome.failure.kind}: ${outcome.failure.error}`,
            jobId: job.jobId,
          };
        }
        return {
          propertyId: property.id,
          phoneNumber: job.owner.phoneNumber,
          status: 'dispatched',
          jobId: outcome.result.jobId,
        };
      } catch (error) {
        return {
          propertyId: property.id,
          phoneNumber: job.owner.phoneNumber,
          status: 'failed',
          reason: String(error),
          jobId: job.jobId,
        };
      }
    },
  );

  const items = [...skippedEarly, ...dispatchResults];
  return {
    fetched: properties.length,
    dispatched: items.filter((i) => i.status === 'dispatched').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    failed: items.filter((i) => i.status === 'failed').length,
    items,
  };
}
