# GullyNest — Voice Agent API

Server-to-server endpoints for **VoiceAgent** (the Sarvam AI + LiveKit outbound-call service, a separate repo) to (1) pull a batch of LIVE properties to call and verify availability for, and (2) report back the outcome of each call so the marketplace listing reflects reality.

- **Base URL:** `https://<your-rental-app-host>`
- **Content-Type:** `application/json`
- **Auth:** shared secret header (see below)
- **Audience:** server-to-server only (VoiceAgent's cron). Do **not** embed the secret in a browser, mobile app, or any client a user can inspect.

---

## 1. Authentication

Every request must carry the shared secret in a header:

```
X-Voice-Admin-Secret: <VOICE_AGENT_API_SECRET>
```

The same value must be set as `VOICE_AGENT_API_SECRET` in both rental-app's environment and VoiceAgent's environment. Requests with a missing or mismatched header get `401`. There is no fallback header (unlike the lead-ingest API) and no per-caller alias — this is a single dedicated integration secret, generated with `openssl rand -hex 32`.

> Send requests over **HTTPS only**. The secret is a shared credential — store it in your server's secret manager / environment, never in source control or client code. If it ever leaks, rotate `VOICE_AGENT_API_SECRET` on both sides; this immediately invalidates the old value with no other side effects (it is not shared with any other integration, e.g. `BOT_ADMIN_API_SECRET` used by gullybot is a separate secret).

---

## 2. `GET /api/voice-admin/properties`

Returns a paginated, filterable list of properties for the cron to call. Defaults to `status=LIVE` (only actually-live listings, not drafts/pending/rejected/hidden ones).

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `status` | comma list: `LIVE`, `SOFT_STALE`, `STALE` — or `ALL` | `LIVE` | e.g. `status=LIVE,SOFT_STALE`. Unrecognized/empty values fall back to `LIVE`. |
| `listingKind` | comma list: `TENANT`, `OWNER`, `AGENT` | all kinds | Who listed the property. |
| `bhk` | comma list, e.g. `1 BHK,2 BHK` | all | Matches GullyNest's BHK values (`1 RK`, `1 BHK`, `2 BHK`, `3 BHK`, `4 BHK`, `4+ BHK`). |
| `rentMin` / `rentMax` | integer | — | Filters `rentMonthly` (₹/month), inclusive. |
| `createdAfter` / `createdBefore` | ISO 8601 datetime | — | Filters `createdAt`, inclusive. |
| `contactedBefore` | ISO 8601 datetime | — | Matches properties **never** voice-contacted, or last contacted before this timestamp. This is the staleness cutoff to avoid re-calling a property too soon — e.g. `contactedBefore=2026-07-17T00:00:00Z` to skip anything called in the last 7 days. |
| `ids` | comma list of property `id` (cuid) or `shortId` (6-digit) | — | Targeted lookup instead of a filtered scan. Max 100. When set, `page`/`pageSize` are ignored — up to `min(ids.length, 100)` matching rows are returned in one page. |
| `page` | integer | `1` | 1-indexed. |
| `pageSize` | integer | `50` | Capped at `200`. |

`deleted` properties are always excluded. To page through everything, loop `page = 1, 2, 3, …` until `page >= totalPages`.

### Example request

```bash
curl "https://<host>/api/voice-admin/properties?listingKind=OWNER,AGENT&contactedBefore=2026-07-17T00:00:00Z&pageSize=100" \
  -H "X-Voice-Admin-Secret: $VOICE_AGENT_API_SECRET"
```

### Example response

```json
{
  "items": [
    {
      "id": "cmq0a1b2c3d4e5f6g7h8i9j0",
      "shortId": "042817",
      "status": "LIVE",
      "listingKind": "OWNER",
      "listingUnitType": "FLAT",
      "bhk": "2 BHK",
      "rentMonthly": 25000,
      "city": "Bengaluru",
      "locality": "Indiranagar",
      "subLocality": "12th Main",
      "formattedAddress": "42, 12th Main, Indiranagar, Bengaluru, Karnataka",
      "listerName": "Ramesh Kumar",
      "listerPhone": "+919876543210",
      "voiceLastContactedAt": null,
      "createdAt": "2026-07-01T09:15:00.000Z"
    }
  ],
  "page": 1,
  "pageSize": 100,
  "total": 213,
  "totalPages": 3
}
```

`listerPhone` is display-formatted (`+91XXXXXXXXXX`) and falls back to the linked `User`'s phone/name when the property-level `listerName`/`listerPhone` fields are empty. It can be `null` if no phone is on file at all — skip those rows.

### Field mapping to VoiceAgent's own call-trigger API

If your cron calls VoiceAgent's `POST /calls/property-availability` (see VoiceAgent's own README) right after fetching, the fields line up directly:

| VoiceAgent job field | From this response |
|---|---|
| `owner_name` | `listerName` |
| `phone_number` | `listerPhone` |
| `property_id` | `id` |
| `property_address` | `formattedAddress` |
| `bhk` | `bhk` |
| `rent_amount` | `rentMonthly` |
| `city` | `city` |

---

## 3. `PATCH /api/voice-admin/properties/{propertyId}/call-outcome`

Records the outcome of a verification call. `{propertyId}` accepts either the property's `id` (cuid) or its `shortId` (6-digit).

### Request body

```json
{ "action": "available" | "soft_stale" | "stale" }
```

| Action | Meaning | Status change | Transition guard |
|---|---|---|---|
| `available` | Owner confirmed the property is still available. | → `LIVE` (revives the listing if it was `SOFT_STALE`/`STALE`). | None. |
| `soft_stale` | Owner didn't answer / gave an unclear answer. Listing stays visible on the marketplace but is hidden from bot search and treated as unavailable. | → `SOFT_STALE` | Current status must be `LIVE`, else `422`. |
| `stale` | Owner confirmed the property is **no longer available**. Listing is fully hidden (marketplace, search, sitemap, and direct link). | → `STALE` | Current status must be `LIVE` or `SOFT_STALE`, else `422`. |

**Every call to this endpoint stamps `voiceLastContactedAt` to the current time, regardless of `action`.** This is what lets the next `GET` request's `contactedBefore` filter skip properties that were just verified.

A positive (`available`) outcome is the **only** way a `SOFT_STALE`/`STALE` listing gets reinstated automatically — it requires the voice agent to have re-confirmed availability directly with the owner. There is no human-review step in this path; the admin dashboard's `unstale` action (`PATCH /api/admin/properties/[propertyId]`) remains available separately for manual reinstatement.

### Example request

```bash
curl -X PATCH "https://<host>/api/voice-admin/properties/042817/call-outcome" \
  -H "X-Voice-Admin-Secret: $VOICE_AGENT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"action": "stale"}'
```

### Example response

```json
{
  "ok": true,
  "action": "stale",
  "property": {
    "id": "cmq0a1b2c3d4e5f6g7h8i9j0",
    "status": "STALE",
    "voiceLastContactedAt": "2026-07-24T10:03:00.000Z",
    "updatedAt": "2026-07-24T10:03:00.000Z"
  }
}
```

### Error responses

| Status | Cause |
|---|---|
| `400` | Malformed JSON body, or `action` missing/invalid. |
| `401` | Missing or incorrect `X-Voice-Admin-Secret`. |
| `404` | No matching, non-deleted property for `{propertyId}`. |
| `422` | Action's transition guard failed (e.g. `soft_stale` on a property that isn't currently `LIVE`). |
| `503` | Database not configured on the rental-app side. |

---

## 4. Operational notes

- Both endpoints run on the Node.js runtime (`export const runtime = 'nodejs'`) and are never statically cached (`export const dynamic = 'force-dynamic'`) — every request hits the database live.
- No CORS handling — these are not meant to be called from a browser.
- No built-in rate limiting yet. If the cron ends up hammering these routes, add one before scaling call volume up.
