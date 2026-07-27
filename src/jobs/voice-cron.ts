import type { Settings } from '../config/settings.js';
import {
  createGullyNestClientFromSettings,
  type GullyNestClient,
} from '../integrations/gullynest/client.js';
import type { VoiceAdminProperty } from '../integrations/gullynest/types.js';
import {
  secureDispatchPropertyAvailabilityCall,
  type SecureDispatchResult,
} from './dispatch-pipeline.js';
import { createPropertyAvailabilityJob } from './models.js';

export interface VoiceCronDeps {
  client: GullyNestClient;
  dispatch: (
    job: ReturnType<typeof createPropertyAvailabilityJob>,
    settings: Settings,
  ) => Promise<SecureDispatchResult>;
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

/**
 * One cron tick: fetch properties from GullyNest (API decides which rows to return)
 * and dispatch an outbound job for each callable row.
 */
export async function runVoiceCronTick(
  settings: Settings,
  deps?: Partial<VoiceCronDeps>,
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

  const properties = await client.listAllProperties();
  const items: VoiceCronItemResult[] = [];

  for (const property of properties) {
    const input = propertyToJobInput(property, settings);
    if (!input) {
      items.push({
        propertyId: property.id,
        phoneNumber: property.listerPhone ?? undefined,
        status: 'skipped',
        reason: 'missing_phone_or_address',
      });
      continue;
    }

    const job = createPropertyAvailabilityJob(input);
    try {
      const outcome = await dispatch(job, settings);
      if (!outcome.ok) {
        items.push({
          propertyId: property.id,
          phoneNumber: job.owner.phoneNumber,
          status: 'failed',
          reason: `${outcome.failure.kind}: ${outcome.failure.error}`,
          jobId: job.jobId,
        });
        continue;
      }

      items.push({
        propertyId: property.id,
        phoneNumber: job.owner.phoneNumber,
        status: 'dispatched',
        jobId: outcome.result.jobId,
      });
    } catch (error) {
      items.push({
        propertyId: property.id,
        phoneNumber: job.owner.phoneNumber,
        status: 'failed',
        reason: String(error),
        jobId: job.jobId,
      });
    }
  }

  return {
    fetched: properties.length,
    dispatched: items.filter((i) => i.status === 'dispatched').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    failed: items.filter((i) => i.status === 'failed').length,
    items,
  };
}

export interface VoiceCronLoopHandle {
  stop(): void;
}

/**
 * Long-running cron: run a tick immediately, then repeat every `voiceCronIntervalMs`.
 */
export function startVoiceCronLoop(
  settings: Settings,
  deps?: Partial<VoiceCronDeps>,
): VoiceCronLoopHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runTick = async (): Promise<void> => {
    const summary = await runVoiceCronTick(settings, deps);
    console.log(
      JSON.stringify({
        tickAt: new Date().toISOString(),
        ...summary,
      }),
    );
  };

  const scheduleNext = (): void => {
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await runTick();
      } catch (error) {
        console.error('Voice cron tick failed:', error);
      }
      if (!stopped) scheduleNext();
    }, settings.voiceCronIntervalMs);
  };

  void (async () => {
    try {
      await runTick();
    } catch (error) {
      console.error('Voice cron tick failed:', error);
    }
    if (!stopped) scheduleNext();
  })();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
