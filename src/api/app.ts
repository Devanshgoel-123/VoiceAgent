import express from 'express';
import rateLimit from 'express-rate-limit';
import type { Settings } from '../config/settings.js';
import { createApiKeyMiddleware } from './auth-middleware.js';
import { propertyAvailabilityRequestSchema } from './schemas.js';
import { CallJobDispatcher } from '../jobs/dispatcher.js';
import {
  createPropertyAvailabilityJob,
  type PropertyAvailabilityCallJob,
} from '../jobs/models.js';
import { CallResultStore } from '../jobs/results.js';
import { isPhoneSuppressed } from '../jobs/suppression.js';
import {
  getCallLogRepository,
  isDatabaseEnabled,
  safeFindBlockingDispatch,
  safeUpsertDispatched,
} from '../db/call-log-repository.js';
import { listAgents } from '../agents/registry.js';

/** Test-only overrides — production uses defaults below. */
export interface CreateAppOptions {
  writeRateLimitMax?: number;
  readRateLimitMax?: number;
}

export function createApp(
  settings: Settings,
  options: CreateAppOptions = {},
): express.Express {
  const app = express();
  app.use(express.json());

  const requireApiKey = createApiKeyMiddleware(settings);
  const dispatcher = new CallJobDispatcher(settings);
  const resultStore = new CallResultStore();

  const callWriteLimiter = rateLimit({
    windowMs: 60_000,
    max: options.writeRateLimitMax ?? 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  const callReadLimiter = rateLimit({
    windowMs: 60_000,
    max: options.readRateLimitMax ?? 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agents: listAgents() });
  });

  app.post(
    '/calls/property-availability',
    requireApiKey,
    callWriteLimiter,
    async (req, res) => {
      try {
        const parsed = propertyAvailabilityRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: 'Invalid request body',
            details: parsed.error.flatten(),
          });
          return;
        }

        const body = parsed.data;

        if (await isPhoneSuppressed(body.phone_number)) {
          res.status(403).json({ error: 'Phone number is on the do-not-call list' });
          return;
        }

        const blocking = await safeFindBlockingDispatch({
          propertyId: body.property_id,
          phoneNumber: body.phone_number,
          cooldownMs: settings.dispatchCooldownMs,
        });
        if (blocking) {
          res.status(409).json({
            error: 'A call for this property or phone number is already active or was placed recently',
            existingJobId: blocking.jobId,
            existingStatus: blocking.status,
          });
          return;
        }

        const job: PropertyAvailabilityCallJob = createPropertyAvailabilityJob({
          owner: { name: body.owner_name, phoneNumber: body.phone_number },
          property: {
            propertyId: body.property_id,
            address: body.property_address,
            propertyType: body.property_type,
            bhk: body.bhk,
            rentAmount: body.rent_amount,
            city: body.city,
          },
          companyName: settings.companyName,
          callerName: body.caller_name?.trim() || settings.callerName,
          preferredLanguage: body.preferred_language,
          metadata:
            body.tts_provider === 'sarvam' || body.tts_provider === 'elevenlabs'
              ? { tts_provider: body.tts_provider }
              : {},
        });

        const result = await dispatcher.dispatchPropertyAvailabilityCall(job);
        await safeUpsertDispatched(job, result);
        res.json(result);
      } catch (error) {
        console.error('Failed to dispatch call job:', error);
        res.status(500).json({ error: String(error) });
      }
    },
  );

  app.get('/calls/results/:jobId', requireApiKey, callReadLimiter, async (req, res) => {
    if (isDatabaseEnabled()) {
      const row = await getCallLogRepository().getByJobId(req.params.jobId);
      if (row) {
        res.json({
          jobId: row.jobId,
          status: row.status,
          propertyStillAvailable:
            row.ownerOutcome === 'yes' || row.ownerOutcome === 'no'
              ? row.ownerOutcome
              : row.ownerOutcome === 'unclear'
                ? 'unclear'
                : 'not_asked',
          conversationLanguage: row.languages[0],
          languagesUsed: row.languages,
          ownerOutcome: row.ownerOutcome,
          success: row.success,
          answered: row.answered,
          transcript: row.transcript,
          transcriptSummary: row.transcriptSummary,
          rawMetadata: row.metadata,
          completedAt: row.completedAt?.toISOString(),
        });
        return;
      }
    }

    const result = await resultStore.load(req.params.jobId);
    if (!result) {
      res.status(404).json({ error: `No result found for job ${req.params.jobId}` });
      return;
    }
    res.json(result);
  });

  app.get('/calls/results', requireApiKey, callReadLimiter, async (_req, res) => {
    if (isDatabaseEnabled()) {
      const rows = await getCallLogRepository().listRecent(100);
      res.json(
        rows.map((row) => ({
          jobId: row.jobId,
          status: row.status,
          ownerOutcome: row.ownerOutcome,
          success: row.success,
          answered: row.answered,
          languagesUsed: row.languages,
          transcriptSummary: row.transcriptSummary,
          propertyId: row.propertyId,
          completedAt: row.completedAt?.toISOString(),
        })),
      );
      return;
    }

    const results = await resultStore.listResults();
    res.json(
      results.map((row) => ({
        jobId: row.jobId,
        status: row.status,
        ownerOutcome: row.ownerOutcome,
        success: row.success,
        answered: row.answered,
        languagesUsed: row.languagesUsed,
        transcriptSummary: row.transcriptSummary,
        completedAt: row.completedAt,
      })),
    );
  });

  return app;
}
