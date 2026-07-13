import { AutoSubscribe, type JobContext, log, voice } from '@livekit/agents';
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

      logger.info(`[CALL] worker.entry:start job=${metadata.job_id ?? ctx.job.id}`);

      const isLocalTest = ctx.isFakeJob;
      const effectiveMetadata =
        isLocalTest && Object.keys(metadata).length === 0
          ? getConsoleTestMetadata()
          : metadata;

      if (isLocalTest) {
        logger.info('[CALL] worker.entry:mode=local_console');
      }

      const roomName = ctx.room.name || ctx.job.room?.name;
      if (!roomName) {
        logger.error('[CALL] worker.entry:fail reason=missing_room_name');
        ctx.shutdown();
        return;
      }

      const phoneNumber = effectiveMetadata.phone_number as string | undefined;
      const participantIdentity = `owner-${effectiveMetadata.property_id ?? 'unknown'}`;
      const isOutboundCall = !isLocalTest && !!phoneNumber;

      logger.info(
        `[CALL] worker.entry:config outbound=${isOutboundCall} identity=${participantIdentity}`,
      );

      if (isOutboundCall) {
        logger.info('[CALL] worker.entry:connect_room');
        await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
        logger.info('[CALL] worker.entry:connect_room_done');
      }

      // PCM TTS for outbound: LiveKit resamples for SIP more reliably than mulaw 8kHz.
      logger.info('[CALL] worker.entry:create_pipeline');
      const pipelineProvider = options.pipeline ?? new SarvamVoicePipeline(settings);
      const pipeline = pipelineProvider.createBundle({ telephony: false });
      logger.info('[CALL] worker.entry:pipeline_ready');

      logger.info('[CALL] worker.entry:create_call_session');
      const callSession = new LiveKitCallSession({
        jobContext: ctx,
        pipeline,
        isOutboundCall,
        participantIdentity,
        logger,
      });

      callSession.createSession();
      logger.info('[CALL] worker.entry:create_agent');
      const agent = agentFactory(effectiveMetadata, callSession);

      logger.info('[CALL] worker.entry:session_start');
      await callSession.start(agent);
      logger.info('[CALL] worker.entry:session_start_done');

      if (!isLocalTest && phoneNumber && settings.sipOutboundTrunkId) {
        try {
          const sip = new LiveKitSipAdapter(settings, logger);
          logger.info('[CALL] worker.entry:dial_start');
          await sip.dial({
            roomName,
            phoneNumber,
            participantIdentity,
            participantName: (metadata.owner_name as string) ?? 'Property Owner',
          });
          logger.info('[CALL] worker.entry:wait_microphone');
          await sip.waitForMicrophone(ctx.room, participantIdentity);
          logger.info('[CALL] worker.entry:bind_participant');
          callSession.setParticipant(participantIdentity);
          logger.info('[CALL] worker.entry:outbound_ready');
        } catch (error) {
          logger.error(`[CALL] worker.entry:outbound_fail error=${error}`);
          ctx.shutdown();
          return;
        }
      } else if (!isLocalTest && phoneNumber) {
        logger.warn('[CALL] worker.entry:skip_dial reason=missing_SIP_OUTBOUND_TRUNK_ID');
      }

      logger.info('[CALL] worker.entry:wait_until_closed');
      await callSession.waitUntilClosed();
      logger.info('[CALL] worker.entry:end');
    },
  };
}

/** Layman: unpacks the JSON bag LiveKit attached to this job (phone, owner, property). */
function parseMetadata(raw: string): CallMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CallMetadata;
  } catch {
    log().warn('[CALL] worker.parseMetadata:fail');
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
