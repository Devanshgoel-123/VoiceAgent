import { AutoSubscribe, type JobContext, log, voice } from '@livekit/agents';
import { LiveKitCallSession } from '../adapters/livekit-call-session.js';
import { LiveKitSipAdapter } from '../adapters/livekit-sip-adapter.js';
import { SarvamVoicePipeline } from '../adapters/sarvam-voice-pipeline.js';
import type { VoicePipelineProvider } from '../adapters/voice-pipeline.js';
import { buildOpeningInstructions } from '../agents/property-availability/prompts.js';
import { OWNER_OPENING_WAIT_MS } from '../config/call-config.js';
import type { Settings } from '../config/settings.js';
import { getSettings } from '../config/settings.js';
import {
  safeMarkCallAnswered,
  safeMarkCallFailed,
  safeMarkCallInProgress,
  safeMarkCallNoAnswer,
} from '../db/call-log-repository.js';
import { CallSessionRecord } from '../jobs/call-session-record.js';
import { callError, callInfo, callWarn } from './call-logger.js';
import { LanguageManager } from './language-manager.js';
import type { CallMetadata } from './types.js';

export type { CallMetadata };

export type AgentFactory = (
  metadata: CallMetadata,
  lifecycle?: import('../adapters/livekit-call-session.js').CallLifecycle,
) => voice.Agent;

export interface WorkerConfig {
  entry: (ctx: JobContext) => Promise<void>;
}

export interface WorkerConfigOptions {
  settings?: Settings;
  pipeline?: VoicePipelineProvider;
}

/** LiveKit job entry: connect, dial, run the voice session, persist results. */
export function createWorkerConfig(
  agentFactory: AgentFactory,
  options: WorkerConfigOptions = {},
): WorkerConfig {
  return {
    entry: async (ctx: JobContext) => {
      const settings = options.settings ?? getSettings();
      const logger = log().child({ room: ctx.room.name });
      const metadata = parseMetadata(ctx.job.metadata);

      callInfo(`call: start job=${metadata.job_id ?? ctx.job.id}`, logger);

      const isLocalTest = ctx.isFakeJob;
      const effectiveMetadata =
        isLocalTest && Object.keys(metadata).length === 0
          ? getConsoleTestMetadata(settings)
          : metadata;

      const roomName = ctx.room.name || ctx.job.room?.name;
      if (!roomName) {
        callError('call: missing room name', logger);
        ctx.shutdown();
        return;
      }

      const phoneNumber = effectiveMetadata.phone_number as string | undefined;
      const participantIdentity = `owner-${effectiveMetadata.property_id ?? 'unknown'}`;
      const isOutboundCall = !isLocalTest && !!phoneNumber;

      if (isOutboundCall) {
        await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
      }

      const pipelineProvider = options.pipeline ?? new SarvamVoicePipeline(settings);
      const requestedTts = String(effectiveMetadata.tts_provider ?? '').toLowerCase();
      const ttsProvider =
        requestedTts === 'elevenlabs' || requestedTts === 'sarvam'
          ? requestedTts
          : settings.ttsProvider;

      const pipeline = pipelineProvider.createBundle({ ttsProvider });
      const callRecord = new CallSessionRecord(effectiveMetadata);
      callRecord.markInProgress();
      await safeMarkCallInProgress(callRecord.jobId);

      const callSession = new LiveKitCallSession({
        jobContext: ctx,
        pipeline,
        isOutboundCall,
        participantIdentity,
        logger,
        callRecord,
      });

      callSession.createSession();
      const agent = agentFactory(effectiveMetadata, callSession);
      await callSession.start(agent);

      if (!isLocalTest && phoneNumber && settings.sipOutboundTrunkId) {
        try {
          const sip = new LiveKitSipAdapter(settings, logger);
          await sip.dial({
            roomName,
            phoneNumber,
            participantIdentity,
            participantName: (metadata.owner_name as string) ?? 'Property Owner',
          });
          await sip.waitForMicrophone(ctx.room, participantIdentity);
          callSession.setParticipant(participantIdentity);
          callRecord.markAnswered();
          await safeMarkCallAnswered(callRecord.jobId);

          callSession.armOpeningGreeting({
            waitMs: OWNER_OPENING_WAIT_MS,
            preferredLanguage:
              LanguageManager.normalizeLanguageCode(
                effectiveMetadata.preferred_language as string | undefined,
              ) ?? 'en-IN',
            buildInstructions: (language) =>
              buildOpeningInstructions(
                {
                  companyName:
                    (effectiveMetadata.company_name as string) ?? settings.companyName,
                  callerName:
                    (effectiveMetadata.caller_name as string) ?? settings.callerName,
                  ownerName: (effectiveMetadata.owner_name as string) ?? 'Owner',
                  propertyAddress:
                    (effectiveMetadata.property_address as string) ?? 'your property',
                },
                language,
              ),
          });
        } catch (error) {
          callError(`call: outbound failed ${error}`, logger);
          const message = String(error);
          if (message.includes('Timed out waiting for microphone')) {
            callRecord.markNoAnswer(message);
            await safeMarkCallNoAnswer(callRecord.jobId, message);
          } else {
            callRecord.markFailed(message);
            await safeMarkCallFailed(callRecord.jobId, message);
          }
          ctx.shutdown();
          return;
        }
      } else if (!isLocalTest && phoneNumber) {
        callWarn('call: skip dial — SIP_OUTBOUND_TRUNK_ID not set', logger);
      }

      await callSession.waitUntilClosed();
    },
  };
}

function parseMetadata(raw: string): CallMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CallMetadata;
  } catch {
    callWarn('call: invalid job metadata JSON');
    return {};
  }
}

function getConsoleTestMetadata(settings: Settings): CallMetadata {
  return {
    job_id: 'console-test-job',
    job_type: 'property_availability',
    owner_name: 'Ramesh Kumar',
    property_id: 'PROP-CONSOLE-001',
    property_address: '42, 5th Cross, Indiranagar, Bangalore',
    property_type: 'rental',
    bhk: '2 BHK',
    rent_amount: 25000,
    city: 'Bangalore',
    company_name: settings.companyName,
    caller_name: settings.callerName,
    tts_provider: settings.ttsProvider,
  };
}
