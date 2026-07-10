import { type JobContext, log, voice } from '@livekit/agents';
import { SipClient } from 'livekit-server-sdk';
import type { Settings } from '../config/settings.js';
import { getSettings } from '../config/settings.js';
import { SarvamPipelineFactory } from './sarvam-pipeline.js';

export type CallMetadata = Record<string, unknown>;

export type AgentFactory = (metadata: CallMetadata) => voice.Agent;

export interface WorkerConfig {
  entry: (ctx: JobContext) => Promise<void>;
}

export function createWorkerConfig(
  agentFactory: AgentFactory,
  options: { telephony?: boolean; settings?: Settings } = {},
): WorkerConfig {
  const telephony = options.telephony ?? true;

  return {
    entry: async (ctx: JobContext) => {
      const settings = options.settings ?? getSettings();
      const logger = log().child({ room: ctx.room.name });
      const metadata = parseMetadata(ctx.job.metadata);

      logger.info(`Job started — metadata keys: ${Object.keys(metadata).join(', ')}`);

      // Console/daemon mode uses a fake job — use job room name, skip SIP, inject test data
      const isLocalTest = ctx.isFakeJob;
      const effectiveMetadata = isLocalTest && Object.keys(metadata).length === 0
        ? getConsoleTestMetadata()
        : metadata;

      const roomName = ctx.room.name || ctx.job.room?.name;
      if (!roomName) {
        logger.error('Room name is missing — cannot start call job');
        ctx.shutdown();
        return;
      }

      const phoneNumber = effectiveMetadata.phone_number as string | undefined;
      const participantIdentity = `owner-${effectiveMetadata.property_id ?? 'unknown'}`;

      if (!isLocalTest && phoneNumber && settings.sipOutboundTrunkId) {
        try {
          await placeOutboundCall(
            settings,
            roomName,
            metadata,
            phoneNumber,
            participantIdentity,
            logger,
          );
        } catch {
          ctx.shutdown();
          return;
        }
      } else if (!isLocalTest && phoneNumber) {
        logger.warn('phone_number provided but SIP_OUTBOUND_TRUNK_ID is not configured');
      }

      const agent = agentFactory(effectiveMetadata);
      const pipeline = new SarvamPipelineFactory(settings);
      // PSTN uses mulaw 8kHz; local console/daemon needs normal PCM for laptop speakers
      const useTelephonyAudio = telephony && !isLocalTest;
      const bundle = pipeline.createPipelineBundle(undefined, useTelephonyAudio);

      const session = new voice.AgentSession({
        stt: bundle.stt,
        llm: bundle.llm,
        tts: bundle.tts,
        // Sarvam docs: use STT speech-boundary signals, not bundled Silero VAD
        vad: null,
        turnHandling: {
          turnDetection: 'stt',
          endpointing: { minDelay: 70 },
          preemptiveGeneration: { enabled: true },
        },
      });

      await session.start({ agent, room: ctx.room });

      if (!isLocalTest && phoneNumber && session._roomIO) {
        session._roomIO.setParticipant(participantIdentity);
      }
    },
  };
}

function parseMetadata(raw: string): CallMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CallMetadata;
  } catch {
    log().warn('Failed to parse job metadata as JSON');
    return {};
  }
}

/** Dummy property data for lk agent console / daemon local testing */
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

async function placeOutboundCall(
  settings: Settings,
  roomName: string,
  metadata: CallMetadata,
  phoneNumber: string,
  participantIdentity: string,
  logger: ReturnType<typeof log>,
): Promise<void> {
  const masked =
    phoneNumber.length > 4
      ? `${'*'.repeat(phoneNumber.length - 4)}${phoneNumber.slice(-4)}`
      : '****';

  logger.info(`Placing outbound SIP call to ${masked}`);

  const sip = new SipClient(
    settings.livekitUrl,
    settings.livekitApiKey,
    settings.livekitApiSecret,
  );

  try {
    await sip.createSipParticipant(
      settings.sipOutboundTrunkId,
      phoneNumber,
      roomName,
      {
        participantIdentity,
        participantName: (metadata.owner_name as string) ?? 'Property Owner',
        waitUntilAnswered: true,
      },
    );
    logger.info('Outbound call answered');
  } catch (error) {
    logger.error(`Outbound call failed: ${error}`);
    throw error;
  }
}
