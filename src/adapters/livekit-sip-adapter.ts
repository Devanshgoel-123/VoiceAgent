import { log } from '@livekit/agents';
import { callDebug, callError } from '../core/call-logger.js';
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

/**
 * Handles outbound phone dialing through LiveKit SIP → Twilio.
 * Layman: this is the "phone dialer" that rings the owner and waits for their mic.
 */
export class LiveKitSipAdapter {
  private readonly settings: Settings;
  private readonly logger: ReturnType<typeof log>;

  constructor(settings: Settings, logger?: ReturnType<typeof log>) {
    this.settings = settings;
    this.logger = logger ?? log();
  }

  /** Layman: place the actual phone call and wait until the owner picks up. */
  async dial(options: SipDialOptions): Promise<void> {
    const masked =
      options.phoneNumber.length > 4
        ? `${'*'.repeat(options.phoneNumber.length - 4)}${options.phoneNumber.slice(-4)}`
        : '****';

    callDebug(`[CALL] sip.dial:start number=${masked} identity=${options.participantIdentity}`, this.logger);

    if (!this.settings.sipOutboundTrunkId) {
      throw new Error('SIP_OUTBOUND_TRUNK_ID is not configured');
    }

    const sip = new SipClient(
      this.settings.livekitUrl,
      this.settings.livekitApiKey,
      this.settings.livekitApiSecret,
    );

    try {
      callDebug('[CALL] sip.dial:createSipParticipant', this.logger);
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
      callDebug('[CALL] sip.dial:answered', this.logger);
    } catch (error) {
      callError(`[CALL] sip.dial:fail error=${error}`, this.logger);
      throw error;
    }
  }

  /**
   * Layman: wait until the owner's phone microphone audio is actually available
   * in the LiveKit room (answered call ≠ audio track ready yet).
   */
  async waitForMicrophone(
    room: Room,
    participantIdentity: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    callDebug(`[CALL] sip.waitForMicrophone:start identity=${participantIdentity} timeoutMs=${timeoutMs}`, this.logger);

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
      callDebug('[CALL] sip.waitForMicrophone:ready already_available', this.logger);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        callError(`[CALL] sip.waitForMicrophone:timeout identity=${participantIdentity}`, this.logger);
        reject(new Error(`Timed out waiting for microphone track from ${participantIdentity}`));
      }, timeoutMs);

      const onPublished = (
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (
          participant.identity === participantIdentity &&
          publication.source === TrackSource.SOURCE_MICROPHONE
        ) {
          callDebug('[CALL] sip.waitForMicrophone:track_published', this.logger);
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
          callDebug('[CALL] sip.waitForMicrophone:ready subscribed', this.logger);
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
