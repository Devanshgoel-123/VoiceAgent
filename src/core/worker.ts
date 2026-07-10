import { AutoSubscribe, type JobContext, log, voice } from '@livekit/agents';
import {
  RoomEvent,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
} from '@livekit/rtc-node';

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
      const isOutboundCall = !isLocalTest && !!phoneNumber;

      if (isOutboundCall) {
        await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
      }

      const agent = agentFactory(effectiveMetadata);
      const pipeline = new SarvamPipelineFactory(settings);
      const bundle = pipeline.createPipelineBundle(undefined, false);

      const session = new voice.AgentSession({
        stt: bundle.stt,
        llm: bundle.llm,
        tts: bundle.tts,
        vad: null,
        turnHandling: {
          turnDetection: 'stt',
          endpointing: { minDelay: isOutboundCall ? 600 : 70 },
          preemptiveGeneration: { enabled: !isOutboundCall },
          interruption: {
            enabled: !isOutboundCall,
            discardAudioIfUninterruptible: isOutboundCall,
          },
        },
      });

      await session.start({
        agent,
        room: ctx.room,
        inputOptions: isOutboundCall
          ? { participantIdentity, closeOnDisconnect: false }
          : undefined,
        outputOptions: isOutboundCall
          ? { syncTranscription: false }
          : undefined,
        record: { audio: true},
      });

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
          await waitForParticipantMicrophone(ctx.room, participantIdentity, logger);
          session._roomIO?.setParticipant(participantIdentity);
        } catch (error) {
          logger.error(`Outbound call setup failed: ${error}`);
          ctx.shutdown();
          return;
        }
      } else if (!isLocalTest && phoneNumber) {
        logger.warn('phone_number provided but SIP_OUTBOUND_TRUNK_ID is not configured');
      }
      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
        logger.info(
          { transcript: ev.transcript, isFinal: ev.isFinal },
          'User said',
        );
      });
      await new Promise<void>((resolve) => {
        session.on(voice.AgentSessionEventTypes.Close, () =>{
          const report = ctx.makeSessionReport(session);
           if (report.audioRecordingPath) {
            logger.info(`Call audio saved: ${report.audioRecordingPath}`);
              resolve();
             }
        });
      });
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

/** SIP participants often join before their mic track is published — wait and subscribe explicitly */
async function waitForParticipantMicrophone(
  room: Room,
  participantIdentity: string,
  logger: ReturnType<typeof log>,
  timeoutMs = 20_000,
): Promise<void> {
  const hasMicTrack = (participant: RemoteParticipant): boolean => {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === TrackSource.SOURCE_MICROPHONE) {
        if (!publication.subscribed) {
          publication.setSubscribed(true);
        }
        return publication.track !== undefined;
      }
    }
    return false;
  };

  const existing = room.remoteParticipants.get(participantIdentity);
  if (existing && hasMicTrack(existing)) {
    logger.info('SIP participant microphone track already available');
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for microphone track from ${participantIdentity}`));
    }, timeoutMs);

    const onPublished = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (
        participant.identity === participantIdentity &&
        publication.source === TrackSource.SOURCE_MICROPHONE
      ) {
        publication.setSubscribed(true);
      }
    };

    const onSubscribed = (
      _track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (
        participant.identity === participantIdentity &&
        publication.source === TrackSource.SOURCE_MICROPHONE
      ) {
        logger.info('SIP participant microphone track subscribed');
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      room.off(RoomEvent.TrackPublished, onPublished);
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
    };

    room.on(RoomEvent.TrackPublished, onPublished);
    room.on(RoomEvent.TrackSubscribed, onSubscribed);

    if (existing) {
      for (const publication of existing.trackPublications.values()) {
        if (publication.source === TrackSource.SOURCE_MICROPHONE) {
          publication.setSubscribed(true);
        }
      }
    }
  });
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
