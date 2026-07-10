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

      const roomName = ctx.room.name;
      if (!roomName) {
        logger.error('Room name is missing — cannot start call job');
        ctx.shutdown();
        return;
      }

      const phoneNumber = metadata.phone_number as string | undefined;
      const participantIdentity = `owner-${metadata.property_id ?? 'unknown'}`;

      if (phoneNumber && settings.sipOutboundTrunkId) {
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
      } else if (phoneNumber) {
        logger.warn('phone_number provided but SIP_OUTBOUND_TRUNK_ID is not configured');
      }

      const agent = agentFactory(metadata);
      const pipeline = new SarvamPipelineFactory(settings);
      const bundle = pipeline.createPipelineBundle(undefined, telephony);

      const session = new voice.AgentSession({
        stt: bundle.stt,
        llm: bundle.llm,
        tts: bundle.tts,
        preemptiveGeneration: true,
      });

      await session.start({ agent, room: ctx.room });

      if (phoneNumber && session._roomIO) {
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
