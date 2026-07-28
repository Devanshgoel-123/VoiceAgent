import type {
  GullyNestClientConfig,
  ListVoicePropertiesQuery,
  VoiceAdminPropertiesResponse,
  VoiceCallOutcomeAction,
  VoiceCallOutcomeResponse,
} from './types.js';

export class GullyNestApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'GullyNestApiError';
    this.status = status;
    this.body = body;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function buildQuery(params: ListVoicePropertiesQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class GullyNestClient {
  private readonly baseUrl: string;
  private readonly apiSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(config: GullyNestClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiSecret = config.apiSecret;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async listProperties(
    query: ListVoicePropertiesQuery = {},
  ): Promise<VoiceAdminPropertiesResponse> {
    const path = `/api/voice-admin/properties${buildQuery(query)}`;
    return this.requestJson<VoiceAdminPropertiesResponse>('GET', path);
  }

  /**
   * Pages through properties until `page >= totalPages` or `maxItems` collected.
   */
  async listAllProperties(
    query: Omit<ListVoicePropertiesQuery, 'page'> = {},
    maxItems = Number.POSITIVE_INFINITY,
  ): Promise<VoiceAdminPropertiesResponse['items']> {
    const pageSize = Math.min(query.pageSize ?? 50, maxItems);
    const items: VoiceAdminPropertiesResponse['items'] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && items.length < maxItems) {
      const response = await this.listProperties({ ...query, page, pageSize });
      totalPages = response.totalPages;
      for (const item of response.items) {
        items.push(item);
        if (items.length >= maxItems) break;
      }
      page += 1;
    }

    return items;
  }

  async reportCallOutcome(
    propertyId: string,
    action: VoiceCallOutcomeAction,
  ): Promise<VoiceCallOutcomeResponse> {
    const encoded = encodeURIComponent(propertyId);
    const path = `/api/voice-admin/properties/${encoded}/call-outcome`;
    return this.requestJson<VoiceCallOutcomeResponse>('PATCH', path, { action });
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Voice-Admin-Secret': this.apiSecret,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new GullyNestApiError(
        `GullyNest API ${method} ${path} failed with ${response.status}`,
        response.status,
        text,
      );
    }

    if (!text) {
      throw new GullyNestApiError(
        `GullyNest API ${method} ${path} returned empty body`,
        response.status,
        text,
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GullyNestApiError(
        `GullyNest API ${method} ${path} returned invalid JSON`,
        response.status,
        text,
      );
    }
  }
}

export function createGullyNestClientFromSettings(settings: {
  voiceAgentApiBaseUrl?: string;
  voiceAgentApiSecret?: string;
}): GullyNestClient | null {
  const baseUrl = settings.voiceAgentApiBaseUrl?.trim();
  const apiSecret = settings.voiceAgentApiSecret?.trim();
  if (!baseUrl || !apiSecret) return null;
  return new GullyNestClient({ baseUrl, apiSecret });
}
