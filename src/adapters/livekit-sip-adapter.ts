import { log } from '@livekit/agents';
import { callError } from '../core/call-logger.js';
import { NoAnswerError } from '../core/telephony-errors.js';
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

export interface SipDialOptions {
  roomName: string;
  phoneNumber: string;
  participantIdentity: string;
  participantName?: string;
}

/** Places outbound calls through LiveKit SIP → Twilio and waits for the owner's mic. */
export class LiveKitSipAdapter {
  private readonly settings: Settings;
  private readonly logger: ReturnType<typeof log>;

  constructor(settings: Settings, logger?: ReturnType<typeof log>) {
    this.settings = settings;
    this.logger = logger ?? log();
  }

  /** Ring the owner and block until they pick up. */
  async dial(options: SipDialOptions): Promise<void> {
    if (!this.settings.sipOutboundTrunkId) {
      throw new Error('SIP_OUTBOUND_TRUNK_ID is not configured');
    }

    const sip = new SipClient(
      this.settings.livekitUrl,
      this.settings.livekitApiKey,
      this.settings.livekitApiSecret,
    );

    try {
      await sip.createSipParticipant(
        this.settings.sipOutboundTrunkId,
        options.phoneNumber,
        options.roomName,
        {
          participantIdentity: options.participantIdentity,
          participantName: options.participantName ?? 'Property Owner',
          waitUntilAnswered: true,
        },
      );
    } catch (error) {
      callError(`[CALL] sip.dial:fail error=${error}`, this.logger);
      throw error;
    }
  }

  /**
   * Wait until the owner's mic audio track is actually subscribed in the room.
   * An answered call does not mean audio is flowing yet.
   */
  async waitForMicrophone(
    room: Room,
    participantIdentity: string,
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
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        callError(`[CALL] sip.waitForMicrophone:timeout identity=${participantIdentity}`, this.logger);
        reject(
          new NoAnswerError(
            `Timed out waiting for microphone track from ${participantIdentity}`,
          ),
        );
      }, timeoutMs);

      const onPublished = (
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
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
}
