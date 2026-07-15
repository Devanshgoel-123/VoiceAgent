import 'dotenv/config';
import express from 'express';
import { getSettings } from '../config/settings.js';
import '../agents/property-availability/agent.js';
import { listAgents } from '../agents/registry.js';
import { CallJobDispatcher } from '../jobs/dispatcher.js';
import {
  createPropertyAvailabilityJob,
  type PropertyAvailabilityCallJob,
} from '../jobs/models.js';
import { CallResultStore } from '../jobs/results.js';
import { getCallLogRepository, isDatabaseEnabled, safeUpsertDispatched } from '../db/call-log-repository.js';

const app = express();
app.use(express.json());

const dispatcher = new CallJobDispatcher();
const resultStore = new CallResultStore();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agents: listAgents() });
});

app.post('/calls/property-availability', async (req, res) => {
  try {
    const {
      owner_name: ownerName,
      phone_number: phoneNumber,
      property_id: propertyId,
      property_address: propertyAddress,
      property_type: propertyType,
      bhk,
      rent_amount: rentAmount,
      city,
      preferred_language: preferredLanguage,
      tts_provider: ttsProvider,
      caller_name: callerName,
    } = req.body;

    if (!ownerName || !phoneNumber || !propertyId || !propertyAddress) {
      res.status(400).json({
        error: 'owner_name, phone_number, property_id, and property_address are required',
      });
      return;
    }

    const settings = getSettings();
    const job: PropertyAvailabilityCallJob = createPropertyAvailabilityJob({
      owner: { name: ownerName, phoneNumber },
      property: {
        propertyId,
        address: propertyAddress,
        propertyType,
        bhk,
        rentAmount,
        city,
      },
      companyName: settings.companyName,
      callerName:
        typeof callerName === 'string' && callerName.trim()
          ? callerName.trim()
          : settings.callerName,
      preferredLanguage,
      metadata:
        ttsProvider === 'sarvam' || ttsProvider === 'elevenlabs'
          ? { tts_provider: ttsProvider }
          : {},
    });

    const result = await dispatcher.dispatchPropertyAvailabilityCall(job);
    await safeUpsertDispatched(job, result);
    res.json(result);
  } catch (error) {
    console.error('Failed to dispatch call job:', error);
    res.status(500).json({ error: String(error) });
  }
});

app.get('/calls/results/:jobId', async (req, res) => {
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

app.get('/calls/results', async (_req, res) => {
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
        phoneNumber: row.phoneNumber,
        ownerName: row.ownerName,
        completedAt: row.completedAt?.toISOString(),
      })),
    );
    return;
  }

  const results = await resultStore.listResults();
  res.json(results);
});

const settings = getSettings();
const port = settings.apiPort;
const host = settings.apiHost;

app.listen(port, host, () => {
  console.log(`Gully Voice Agent API listening on http://${host}:${port}`);
});
