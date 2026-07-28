/** Property status values returned by GullyNest voice-admin API. */
export type VoicePropertyStatus = 'LIVE' | 'SOFT_STALE' | 'STALE' | 'ALL';

export type VoiceListingKind = 'TENANT' | 'OWNER' | 'AGENT';

export type VoiceCallOutcomeAction = 'available' | 'soft_stale' | 'stale';

export interface VoiceAdminProperty {
  id: string;
  shortId: string;
  status: Exclude<VoicePropertyStatus, 'ALL'>;
  listingKind: VoiceListingKind;
  listingUnitType: string;
  bhk: string | null;
  rentMonthly: number | null;
  city: string | null;
  locality: string | null;
  subLocality: string | null;
  formattedAddress: string | null;
  listerName: string | null;
  listerPhone: string | null;
  voiceLastContactedAt: string | null;
  createdAt: string;
}

export interface VoiceAdminPropertiesResponse {
  items: VoiceAdminProperty[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ListVoicePropertiesQuery {
  /** Comma list of VoicePropertyStatus values, or 'ALL' — matches listingKind/bhk's comma-list shape. */
  status?: string;
  listingKind?: string;
  bhk?: string;
  rentMin?: number;
  rentMax?: number;
  createdAfter?: string;
  createdBefore?: string;
  contactedBefore?: string;
  ids?: string;
  page?: number;
  pageSize?: number;
}

export interface VoiceCallOutcomeResponse {
  ok: true;
  action: VoiceCallOutcomeAction;
  property: {
    id: string;
    status: Exclude<VoicePropertyStatus, 'ALL'>;
    voiceLastContactedAt: string;
    updatedAt: string;
  };
}

export interface GullyNestClientConfig {
  baseUrl: string;
  apiSecret: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Abort a request after this long (default 10s). */
  requestTimeoutMs?: number;
}
