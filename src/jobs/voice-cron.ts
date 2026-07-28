import {
  VOICE_CRON_PROPERTY_STATUSES,
  VOICE_RECONTACT_COOLDOWN_MS,
} from '../config/call-config.js';
import type { Settings } from '../config/settings.js';
import {
  createGullyNestClientFromSettings,
  type GullyNestClient,
} from '../integrations/gullynest/client.js';
import type {
  ListVoicePropertiesQuery,
  VoiceAdminProperty,
} from '../integrations/gullynest/types.js';
import {
  secureDispatchPropertyAvailabilityCall,
  type SecureDispatchResult,
} from './dispatch-pipeline.js';
import { createPropertyAvailabilityJob } from './models.js';

/** Listing statuses the cron is allowed to dial (must match fetch query). */
export const CALLABLE_VOICE_STATUSES = VOICE_CRON_PROPERTY_STATUSES;

export interface VoiceCronDeps {
  client: GullyNestClient;
  dispatch: (
    job: ReturnType<typeof createPropertyAvailabilityJob>,
    settings: Settings,
  ) => Promise<SecureDispatchResult>;
  now?: Date;
  /** Cap on properties fetched + processed in one tick (default: unlimited). */
  maxProperties?: number;
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

/** ISO cutoff for GullyNest `contactedBefore` (never contacted, or older than cooldown). */
export function voiceContactedBeforeCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - VOICE_RECONTACT_COOLDOWN_MS).toISOString();
}

export function isCallableVoiceStatus(
  status: VoiceAdminProperty['status'],
): boolean {
  return (CALLABLE_VOICE_STATUSES as readonly string[]).includes(status);
}

/** True when GullyNest last-contact is still inside the recontact cooldown window. */
export function wasContactedWithinCooldown(
  property: Pick<VoiceAdminProperty, 'voiceLastContactedAt'>,
  now: Date = new Date(),
  cooldownMs: number = VOICE_RECONTACT_COOLDOWN_MS,
): boolean {
  if (!property.voiceLastContactedAt) return false;
  const contactedAt = Date.parse(property.voiceLastContactedAt);
  if (!Number.isFinite(contactedAt)) return false;
  return now.getTime() - contactedAt < cooldownMs;
}

function dedupePropertiesById(
  properties: VoiceAdminProperty[],
): VoiceAdminProperty[] {
  const seen = new Set<string>();
  const unique: VoiceAdminProperty[] = [];
  for (const property of properties) {
    if (seen.has(property.id)) continue;
    seen.add(property.id);
    unique.push(property);
  }
  return unique;
}

/**
 * Fetch LIVE + SOFT_STALE properties that were never contacted, or last contacted
 * before the 7-day recontact cutoff. One request — GullyNest's `status` param takes
 * a comma list, so both statuses are requested together instead of one call each.
 */
export async function fetchCallableVoiceProperties(
  client: GullyNestClient,
  now: Date = new Date(),
  maxProperties?: number,
): Promise<VoiceAdminProperty[]> {
  const contactedBefore = voiceContactedBeforeCutoff(now);
  const query: Omit<ListVoicePropertiesQuery, 'page'> = {
    status: VOICE_CRON_PROPERTY_STATUSES.join(','),
    contactedBefore,
  };

  const fetched =
    maxProperties === undefined
      ? await client.listAllProperties(query)
      : await client.listAllProperties(query, maxProperties);

  const properties = dedupePropertiesById(fetched).filter((property) => {
    if (!isCallableVoiceStatus(property.status)) return false;
    if (wasContactedWithinCooldown(property, now)) return false;
    return true;
  });

  return typeof maxProperties === 'number'
    ? properties.slice(0, maxProperties)
    : properties;
}

/**
 * One cron tick: fetch LIVE / SOFT_STALE properties due for a call and dispatch
 * an outbound job for each callable row.
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
  const now = deps?.now ?? new Date();

  const properties = await fetchCallableVoiceProperties(
    client,
    now,
    deps?.maxProperties,
  );
  const items: VoiceCronItemResult[] = [];
  /** Same owner can list multiple properties — dispatch at most one call per phone per tick;
   *  the rest queue for a later tick instead of ringing the same person back-to-back. */
  const dispatchedPhones = new Set<string>();

  for (const property of properties) {
    if (!isCallableVoiceStatus(property.status)) {
      items.push({
        propertyId: property.id,
        phoneNumber: property.listerPhone ?? undefined,
        status: 'skipped',
        reason: `status_${property.status.toLowerCase()}`,
      });
      continue;
    }

    if (wasContactedWithinCooldown(property, now)) {
      items.push({
        propertyId: property.id,
        phoneNumber: property.listerPhone ?? undefined,
        status: 'skipped',
        reason: 'contacted_within_week',
      });
      continue;
    }

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

    if (dispatchedPhones.has(input.owner.phoneNumber)) {
      items.push({
        propertyId: property.id,
        phoneNumber: input.owner.phoneNumber,
        status: 'skipped',
        reason: 'queued_same_phone_this_tick',
      });
      continue;
    }
    dispatchedPhones.add(input.owner.phoneNumber);

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
