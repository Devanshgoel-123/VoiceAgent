import { AutoSubscribe, type JobContext, log, voice } from '@livekit/agents';
import { callDebug, callError, callInfo, callWarn } from './call-logger.js';
import { LiveKitCallSession } from '../adapters/livekit-call-session.js';
import { LiveKitSipAdapter } from '../adapters/livekit-sip-adapter.js';
import { SarvamVoicePipeline } from '../adapters/sarvam-voice-pipeline.js';
import type { VoicePipelineProvider } from '../adapters/voice-pipeline.js';
import type { Settings } from '../config/settings.js';
import { getSettings } from '../config/settings.js';

export type CallMetadata = Record<string, unknown>;

export type AgentFactory = (
  metadata: CallMetadata,
  lifecycle?: import('../adapters/livekit-call-session.js').CallLifecycle,
) => voice.Agent;

export interface WorkerConfig {
  entry: (ctx: JobContext) => Promise<void>;
}

export interface WorkerConfigOptions {
  telephony?: boolean;
  settings?: Settings;
  pipeline?: VoicePipelineProvider;
}

/**
 * Builds the LiveKit job entrypoint.
 * Layman: this is the "main script" that runs every time LiveKit assigns a call job.
 */
export function createWorkerConfig(
  agentFactory: AgentFactory,
  options: WorkerConfigOptions = {},
): WorkerConfig {
  return {
    entry: async (ctx: JobContext) => {
      const settings = options.settings ?? getSettings();
      console.log('settings', settings);
      const logger = log().child({ room: ctx.room.name });
      const metadata = parseMetadata(ctx.job.metadata);

      callInfo(
        `[CALL] worker.entry:start job=${metadata.job_id ?? ctx.job.id} appEnv=${settings.appEnv} callDebug=${settings.callDebugLogging}`,
        logger,
      );
      callDebug('[CALL] worker.entry:debug_tracing_enabled', logger);

      const isLocalTest = ctx.isFakeJob;
      const effectiveMetadata =
        isLocalTest && Object.keys(metadata).length === 0
          ? getConsoleTestMetadata()
          : metadata;

      if (isLocalTest) {
        callDebug('[CALL] worker.entry:mode=local_console', logger);
      }

      const roomName = ctx.room.name || ctx.job.room?.name;
      if (!roomName) {
        callError('[CALL] worker.entry:fail reason=missing_room_name', logger);
        ctx.shutdown();
        return;
      }

      const phoneNumber = effectiveMetadata.phone_number as string | undefined;
      const participantIdentity = `owner-${effectiveMetadata.property_id ?? 'unknown'}`;
      const isOutboundCall = !isLocalTest && !!phoneNumber;

      callDebug(`[CALL] worker.entry:config outbound=${isOutboundCall} identity=${participantIdentity}`, logger);

      if (isOutboundCall) {
        callDebug('[CALL] worker.entry:connect_room', logger);
        await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
        callDebug('[CALL] worker.entry:connect_room_done', logger);
      }

      // PCM TTS for outbound: LiveKit resamples for SIP more reliably than mulaw 8kHz.
      callDebug('[CALL] worker.entry:create_pipeline', logger);
      const pipelineProvider = options.pipeline ?? new SarvamVoicePipeline(settings);
      const pipeline = pipelineProvider.createBundle({ telephony: false });
      callDebug('[CALL] worker.entry:pipeline_ready', logger);

      callDebug('[CALL] worker.entry:create_call_session', logger);
      const callSession = new LiveKitCallSession({
        jobContext: ctx,
        pipeline,
        isOutboundCall,
        participantIdentity,
        logger,
      });

      callSession.createSession();
      callDebug('[CALL] worker.entry:create_agent', logger);
      const agent = agentFactory(effectiveMetadata, callSession);

      callDebug('[CALL] worker.entry:session_start', logger);
      await callSession.start(agent);
      callDebug('[CALL] worker.entry:session_start_done', logger);

      if (!isLocalTest && phoneNumber && settings.sipOutboundTrunkId) {
        try {
          const sip = new LiveKitSipAdapter(settings, logger);
          callDebug('[CALL] worker.entry:dial_start', logger);
          await sip.dial({
            roomName,
            phoneNumber,
            participantIdentity,
            participantName: (metadata.owner_name as string) ?? 'Property Owner',
          });
          callDebug('[CALL] worker.entry:wait_microphone', logger);
          await sip.waitForMicrophone(ctx.room, participantIdentity);
          callDebug('[CALL] worker.entry:bind_participant', logger);
          callSession.setParticipant(participantIdentity);
          callDebug('[CALL] worker.entry:outbound_ready', logger);
        } catch (error) {
          callError(`[CALL] worker.entry:outbound_fail error=${error}`, logger);
          ctx.shutdown();
          return;
        }
      } else if (!isLocalTest && phoneNumber) {
        callWarn('[CALL] worker.entry:skip_dial reason=missing_SIP_OUTBOUND_TRUNK_ID', logger);
      }

      callDebug('[CALL] worker.entry:wait_until_closed', logger);
      await callSession.waitUntilClosed();
      callDebug('[CALL] worker.entry:end', logger);
    },
  };
}

/** Layman: unpacks the JSON bag LiveKit attached to this job (phone, owner, property). */
function parseMetadata(raw: string): CallMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CallMetadata;
  } catch {
    callWarn('[CALL] worker.parseMetadata:fail');
    return {};
  }
}

/** Layman: fake property details used only for local console testing. */
function getConsoleTestMetadata(): CallMetadata {
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
    company_name: 'Gullynest',
  };
}
