import {
  VOICE_CRON_LISTING_KIND,
  VOICE_CRON_PROPERTY_STATUSES,
  VOICE_RECONTACT_COOLDOWN_MS,
} from '../config/call-config.js';
import type { Settings } from '../config/settings.js';
import {
  getCallLogRepository,
  isDatabaseEnabled,
} from '../db/call-log-repository.js';
import {
  createGullyNestClientFromSettings,
  type GullyNestClient,
} from '../integrations/gullynest/client.js';
import type {
  ListVoicePropertiesQuery,
  VoiceAdminProperty,
} from '../integrations/gullynest/types.js';
import { evaluateDispatchCompliance } from './compliance.js';
import {
  secureDispatchPropertyAvailabilityCall,
  type SecureDispatchOptions,
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
    options?: SecureDispatchOptions,
  ) => Promise<SecureDispatchResult>;
  now?: Date;
  /** Cap on properties fetched + processed in one tick (default: unlimited). */
  maxProperties?: number;
  /** Preview mode: fetch + evaluate as normal, but never actually dispatch a call. */
  dryRun?: boolean;
  /**
   * Targeted mode: comma list of property id (cuid) or shortId. When set, this is
   * the *only* selection criterion sent to GullyNest — status/listingKind/
   * contactedBefore/createdAfter/createdBefore are all dropped, and the returned
   * properties are dispatched as-is with no further eligibility filtering.
   */
  propertyIds?: string;
  /**
   * Only fetch properties listed (created) in this window — ISO 8601. Required
   * unless `propertyIds` is set (runVoiceCronTick throws otherwise).
   */
  createdAfter?: string;
  createdBefore?: string;
  /**
   * Skip the "a call for this property and phone number was placed recently"
   * cooldown conflict. Does not skip the already-active-call conflict check.
   */
  forced?: boolean;
}

export interface VoiceCronItemResult {
  propertyId: string;
  phoneNumber?: string;
  status: 'dispatched' | 'would_dispatch' | 'skipped' | 'failed';
  reason?: string;
  jobId?: string;
}

export interface VoiceCronSummary {
  fetched: number;
  dispatched: number;
  wouldDispatch: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  items: VoiceCronItemResult[];
}

/** Read-only suppression check — safe to call in dry-run mode (no reservation/write). */
async function checkSuppressed(phoneNumber: string): Promise<boolean> {
  if (!isDatabaseEnabled()) return false;
  try {
    return await getCallLogRepository().isPhoneSuppressed(phoneNumber);
  } catch {
    return false;
  }
}

/** One line per property, logged as each item's outcome is decided. */
function logCronItem(item: VoiceCronItemResult): void {
  const payload = {
    event: 'voice_cron_item',
    propertyId: item.propertyId,
    status: item.status,
    ...(item.jobId ? { jobId: item.jobId } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
  };
  if (item.status === 'failed') {
    console.error(JSON.stringify(payload));
  } else {
    console.log(JSON.stringify(payload));
  }
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

/** Voice cron only ever dials properties the owner themselves listed. */
export function isOwnerListing(
  listingKind: VoiceAdminProperty['listingKind'],
): boolean {
  return listingKind === VOICE_CRON_LISTING_KIND;
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

export interface FetchCallablePropertiesOptions {
  now?: Date;
  /** Cap on properties fetched (default: unlimited). */
  maxProperties?: number;
  /**
   * Targeted mode: comma list of property id (cuid) or shortId. When set, this
   * is the only selection criterion sent — status/listingKind/contactedBefore/
   * createdAfter/createdBefore are all skipped, server-side and client-side.
   */
  propertyIds?: string;
  /** Only fetch properties listed (created) in this window — ISO 8601. Required unless `propertyIds` is set. */
  createdAfter?: string;
  createdBefore?: string;
}

/**
 * Fetch LIVE + SOFT_STALE, owner-listed properties created within [createdAfter,
 * createdBefore) that were never voice-contacted, or last contacted before the
 * 7-day recontact cutoff. One request — GullyNest's `status` param takes a comma
 * list, so both statuses are requested together instead of one call each.
 *
 * If `propertyIds` is set instead, none of the above applies: fetches exactly
 * those properties by id, with no status/listingKind/date filtering at all.
 */
export async function fetchCallableVoiceProperties(
  client: GullyNestClient,
  options: FetchCallablePropertiesOptions,
): Promise<VoiceAdminProperty[]> {
  const now = options.now ?? new Date();
  const { maxProperties, propertyIds } = options;

  if (propertyIds) {
    // Targeted mode: the caller asked for these specific properties — capping
    // the result would silently drop some of them, so maxProperties doesn't apply.
    const query: Omit<ListVoicePropertiesQuery, 'page'> = { ids: propertyIds, status: 'ALL' }; //status all to bypass status check on api end
    const fetched = await client.listAllProperties(query);
    return dedupePropertiesById(fetched);
  }

  const { createdAfter, createdBefore } = options;
  if (!createdAfter || !createdBefore) {
    throw new Error(
      'createdAfter and createdBefore are required when propertyIds is not set',
    );
  }

  const contactedBefore = voiceContactedBeforeCutoff(now);
  const query: Omit<ListVoicePropertiesQuery, 'page'> = {
    status: VOICE_CRON_PROPERTY_STATUSES.join(','),
    listingKind: VOICE_CRON_LISTING_KIND,
    contactedBefore,
    createdAfter,
    createdBefore,
  };

  const fetched =
    maxProperties === undefined
      ? await client.listAllProperties(query)
      : await client.listAllProperties(query, maxProperties);

  const properties = dedupePropertiesById(fetched).filter((property) => {
    if (!isCallableVoiceStatus(property.status)) return false;
    if (!isOwnerListing(property.listingKind)) return false;
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

  if (!deps?.propertyIds && (!deps?.createdAfter || !deps?.createdBefore)) {
    throw new Error(
      'createdAfter and createdBefore are required for voice-cron (pass --created-after/' +
        '--created-before), unless --property-id is set',
    );
  }

  const dispatch: VoiceCronDeps['dispatch'] =
    deps?.dispatch ??
    ((job, jobSettings, options) =>
      secureDispatchPropertyAvailabilityCall(job, jobSettings, undefined, options));
  const now = deps?.now ?? new Date();

  const properties = await fetchCallableVoiceProperties(client, {
    now,
    maxProperties: deps?.maxProperties,
    propertyIds: deps?.propertyIds,
    createdAfter: deps?.createdAfter,
    createdBefore: deps?.createdBefore,
  });
  const items: VoiceCronItemResult[] = [];
  const record = (item: VoiceCronItemResult): void => {
    items.push(item);
    logCronItem(item);
  };
  /** Same owner can list multiple properties — dispatch at most one call per phone per tick;
   *  the rest queue for a later tick instead of ringing the same person back-to-back. */
  const dispatchedPhones = new Set<string>();

  // Status/listingKind/cooldown are already enforced by fetchCallableVoiceProperties's
  // own filter above — `properties` never contains a row that would fail them, so
  // there's nothing to re-check here beyond what's actually unvalidated so far.
  for (const property of properties) {
    const input = propertyToJobInput(property, settings);
    if (!input) {
      record({
        propertyId: property.id,
        phoneNumber: property.listerPhone ?? undefined,
        status: 'skipped',
        reason: 'missing_phone_or_address',
      });
      continue;
    }

    if (dispatchedPhones.has(input.owner.phoneNumber)) {
      record({
        propertyId: property.id,
        phoneNumber: input.owner.phoneNumber,
        status: 'skipped',
        reason: 'queued_same_phone_this_tick',
      });
      continue;
    }
    dispatchedPhones.add(input.owner.phoneNumber);

    if (deps?.dryRun) {
      const compliance = evaluateDispatchCompliance({
        settings,
        isSuppressed: await checkSuppressed(input.owner.phoneNumber),
        now,
      });
      if (!compliance.allowed) {
        record({
          propertyId: property.id,
          phoneNumber: input.owner.phoneNumber,
          status: 'skipped',
          reason: `would_be_blocked: ${compliance.reason}`,
        });
        continue;
      }

      record({
        propertyId: property.id,
        phoneNumber: input.owner.phoneNumber,
        status: 'would_dispatch',
      });
      continue;
    }

    const job = createPropertyAvailabilityJob(input);
    try {
      const outcome = await dispatch(job, settings, { forced: deps?.forced });
      if (!outcome.ok) {
        record({
          propertyId: property.id,
          phoneNumber: job.owner.phoneNumber,
          status: 'failed',
          reason: `${outcome.failure.kind}: ${outcome.failure.error}`,
          jobId: job.jobId,
        });
        continue;
      }

      record({
        propertyId: property.id,
        phoneNumber: job.owner.phoneNumber,
        status: 'dispatched',
        jobId: outcome.result.jobId,
      });
    } catch (error) {
      record({
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
    wouldDispatch: items.filter((i) => i.status === 'would_dispatch').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    failed: items.filter((i) => i.status === 'failed').length,
    dryRun: Boolean(deps?.dryRun),
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
