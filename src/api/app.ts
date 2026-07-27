import express from 'express';
import rateLimit from 'express-rate-limit';
import type { Settings } from '../config/settings.js';
import { createApiKeyMiddleware } from './auth-middleware.js';
import {
  propertyAvailabilityRequestSchema,
  suppressionRequestSchema,
} from './schemas.js';
import { CallJobDispatcher } from '../jobs/dispatcher.js';
import { secureDispatchPropertyAvailabilityCall } from '../jobs/dispatch-pipeline.js';
import {
  createPropertyAvailabilityJob,
  type PropertyAvailabilityCallJob,
} from '../jobs/models.js';
import { CallResultStore } from '../jobs/results.js';
import { getCallLogRepository, isDatabaseEnabled } from '../db/call-log-repository.js';
import { listAgents } from '../agents/registry.js';

/** Test-only overrides — production uses settings defaults. */
export interface CreateAppOptions {
  readRateLimitMax?: number;
  suppressionWriteRateLimitMax?: number;
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

  const callReadLimiter = rateLimit({
    windowMs: 60_000,
    max: options.readRateLimitMax ?? settings.apiReadRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const suppressionWriteLimiter = rateLimit({
    windowMs: 60_000,
    max:
      options.suppressionWriteRateLimitMax ??
      settings.apiSuppressionWriteRateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agents: listAgents() });
  });

  app.post('/calls/property-availability', requireApiKey, async (req, res) => {
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
      console.log('job', job);
      const outcome = await secureDispatchPropertyAvailabilityCall(
        job,
        settings,
        dispatcher,
      );
      console.log('outcome', outcome);
      if (!outcome.ok) {
        const { failure } = outcome;
        if (failure.kind === 'compliance') {
          res.status(failure.status).json({
            error: failure.error,
            reason: failure.reason,
          });
          return;
        }
        if (failure.kind === 'conflict') {
          res.status(failure.status).json({
            error: failure.error,
            existingJobId: failure.existingJobId,
            existingStatus: failure.existingStatus,
          });
          return;
        }
        res.status(failure.status).json({ error: failure.error });
        return;
      }

      res.json(outcome.result);
    } catch (error) {
      console.error('Failed to dispatch call job:', error);
      res.status(500).json({ error: String(error) });
    }
  });

  app.post(
    '/suppressed-numbers',
    requireApiKey,
    suppressionWriteLimiter,
    async (req, res) => {
      if (!isDatabaseEnabled()) {
        res.status(503).json({ error: 'DATABASE_URL is required for suppression writes' });
        return;
      }

      const parsed = suppressionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid request body',
          details: parsed.error.flatten(),
        });
        return;
      }

      try {
        const created = await getCallLogRepository().addPhoneSuppression(
          parsed.data.phone_number,
          parsed.data.reason,
        );
        res.status(created ? 201 : 200).json({ ok: true, created });
      } catch (error) {
        console.error('Failed to add suppression entry:', error);
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
