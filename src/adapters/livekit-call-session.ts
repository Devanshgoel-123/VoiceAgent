import { getJobContext, type JobContext, log, voice } from '@livekit/agents';
import { callDebug, callError, callWarn } from '../core/call-logger.js';
import { safeCompleteCallLog } from '../db/call-log-repository.js';
import { getSettings } from '../config/settings.js';
import type { OwnerOutcome } from '../jobs/call-log-types.js';
import { CallSessionRecord } from '../jobs/call-session-record.js';
import { saveCallResultSnapshot } from '../jobs/persist-call-result.js';
import {
  LanguageManager,
  type LanguageCode,
} from '../core/language-manager.js';
import { applySpokenLanguage } from './spoken-language.js';
import type { VoicePipelineBundle } from './voice-pipeline.js';

export const DEFAULT_GOODBYE_TEXT = 'Thank you. Goodbye.';
export type AvailabilityOutcome = 'yes' | 'no';

/**
 * Business closing spoken after recording availability.
 * "dot com" is intentional: phone TTS pronounces it more clearly than ".com".
 */
export function availabilityClosing(
  outcome: AvailabilityOutcome,
  language: LanguageCode = 'en-IN',
): string {
  if (language === 'hi-IN') {
    return outcome === 'yes'
      ? 'धन्यवाद। गुल्लीनेस्ट टीम आपके लिए किरायेदार ढूँढना जारी रखेगी। जैसे ही हमें आपके लिए किरायेदार मिलेगा, हम आपको कॉल करेंगे। कृपया इस नंबर को गुल्लीनेस्ट प्रॉपर्टी टीम के नाम से सेव कर लें। आपका दिन शुभ हो।'
      : 'जानकारी देने के लिए धन्यवाद। हम अपने रिकॉर्ड अपडेट कर देंगे और आपको दोबारा परेशान नहीं करेंगे। अगर भविष्य में आपको किरायेदार ढूँढना हो, तो गुल्लीनेस्ट डॉट कॉम पर जाएँ। आपका दिन शुभ हो।';
  }

  if (language === 'kn-IN') {
    return outcome === 'yes'
      ? 'ಧನ್ಯವಾದಗಳು. ಗುಲ್ಲಿನೆಸ್ಟ್ ತಂಡವು ನಿಮಗಾಗಿ ಬಾಡಿಗೆದಾರರನ್ನು ಹುಡುಕುವುದನ್ನು ಮುಂದುವರಿಸುತ್ತದೆ. ನಿಮಗಾಗಿ ಬಾಡಿಗೆದಾರರು ಸಿಕ್ಕ ತಕ್ಷಣ ನಾವು ನಿಮಗೆ ಕರೆ ಮಾಡುತ್ತೇವೆ. ದಯವಿಟ್ಟು ಈ ಸಂಖ್ಯೆಯನ್ನು ಗುಲ್ಲಿನೆಸ್ಟ್ ಪ್ರಾಪರ್ಟಿ ಟೀಮ್ ಎಂದು ಸೇವ್ ಮಾಡಿಕೊಳ್ಳಿ. ನಿಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ.'
      : 'ಮಾಹಿತಿ ನೀಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಾವು ನಮ್ಮ ದಾಖಲೆಗಳನ್ನು ನವೀಕರಿಸುತ್ತೇವೆ ಮತ್ತು ನಿಮಗೆ ಮತ್ತೆ ತೊಂದರೆ ನೀಡುವುದಿಲ್ಲ. ಭವಿಷ್ಯದಲ್ಲಿ ಬಾಡಿಗೆದಾರರನ್ನು ಹುಡುಕಬೇಕಾದರೆ, ಗುಲ್ಲಿನೆಸ್ಟ್ ಡಾಟ್ ಕಾಮ್‌ಗೆ ಭೇಟಿ ನೀಡಿ. ನಿಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ.';
  }

  if (outcome === 'yes') {
    return (
      'Thank you. The Galiynest team will continue searching for tenants. ' +
      'We will call you as soon as we find a tenant for you. ' +
      'We recommend saving this number as Galynest Property Team. ' +
      'Have a good day.'
    );
  }

  return (
    'Thank you for the information. We will update our records and will not disturb you again. ' +
    'If you want to search for a tenant in the future, simply visit Galynest dot com. ' +
    'Have a good day.'
  );
}

export function goodbyeForLanguage(language: LanguageCode): string {
  if (language === 'hi-IN') {
    return 'धन्यवाद।';
  }
  if (language === 'kn-IN') {
    return 'ಧನ್ಯವಾದಗಳು।';
  }
  return DEFAULT_GOODBYE_TEXT;
}
/** Long outcome-specific closing at slow TTS speed needs substantial playout headroom. */
export const GOODBYE_PLAYOUT_TIMEOUT_MS = 20000;
/** Base SIP flush after local playout; scaled up further when TTS_SPEED < 1. */
export const GOODBYE_SIP_DRAIN_GRACE_MS = 1_500;
/** Leave the tool stack, then wait for the model closing speech and hang up. */
export const HANGUP_DEFER_MS = 800;
/** If session Close never fires after shutdown, delete the room anyway. */
export const CLOSE_FALLBACK_TIMEOUT_MS = 1500;

/** How long to wait for the owner to speak after the call connects before we introduce ourselves. */
export const OWNER_OPENING_WAIT_MS = 1000;
/**
 * Outbound endpointing delay (ms) after STT thinks the user stopped talking.
 * Lower = faster replies; too low risks cutting the owner off mid-sentence.
 */
export const OUTBOUND_ENDPOINTING_MIN_MS = 250;
/** Fallback commit after a final STT transcript if LiveKit has not ended the turn yet. */
export const TURN_COMMIT_FALLBACK_MS = 250;

export type CallMetadata = Record<string, unknown>;

export interface CallLifecycle {
  /**
   * After availability is recorded: wait for the model closing speech, then hang up.
   * Idempotent.
   */
  scheduleHangup(outcome?: AvailabilityOutcome): void;

  /**
   * Switch TTS (+ tracked language) so greeting/replies match the owner.
   * Safe to call on every turn; no-ops when language is unchanged.
   */
  setSpokenLanguage(language: LanguageCode, reason?: string): void;

  /** Current conversation language tracked by the session. */
  getCurrentLanguage(): LanguageCode;

  /** Record owner yes/no/other before the closing turn. */
  recordOwnerOutcome(outcome: OwnerOutcome, summary: string): void;
}

export interface OpeningGreetingOptions {
  /** Max silence after mic is ready before the agent introduces itself. */
  waitMs?: number;
  /** Fallback language when the owner stays silent (job preferred_language or en-IN). */
  preferredLanguage?: LanguageCode;
  /** LLM instructions for the opening turn (model generates spoken text). */
  buildInstructions: (language: LanguageCode) => string;
}

export interface LiveKitCallSessionOptions {
  jobContext: JobContext;
  pipeline: VoicePipelineBundle;
  isOutboundCall: boolean;
  participantIdentity?: string;
  goodbyeText?: string;
  callRecord?: CallSessionRecord;
  logger?: ReturnType<typeof log>;
}

/**
 * Owns AgentSession lifecycle: start, turn logging, goodbye, session shutdown, room delete.
 * Layman: this is the "call room manager" — it starts the conversation engine and ends the call cleanly.
 */
export class LiveKitCallSession implements CallLifecycle {
  private readonly ctx: JobContext;
  private readonly logger: ReturnType<typeof log>;
  private readonly goodbyeText: string;
  private readonly isOutboundCall: boolean;
  private readonly participantIdentity?: string;
  private readonly pipeline: VoicePipelineBundle;
  private readonly callRecord?: CallSessionRecord;
  private persistStarted = false;
  private session?: voice.AgentSession;
  private hangupStarted = false;
  private hangupScheduled = false;
  private availabilityOutcome?: AvailabilityOutcome;
  private roomDeleted = false;
  private closeResolved = false;
  private resolveClose?: () => void;
  private closePromise?: Promise<void>;
  private openingTimer?: ReturnType<typeof setTimeout>;
  private openingArmed = false;
  private openingGreeted = false;
  /** Owner started speaking during opening; wait for final transcript to pick language. */
  private pendingOwnerLanguageGreeting = false;
  private skipNextTurnCommit = false;
  private openingBuildInstructions?: (language: LanguageCode) => string;
  private preferredOpeningLanguage: LanguageCode = 'en-IN';
  private readonly languageManager = new LanguageManager('en-IN');
  /** Last language pushed into Sarvam TTS (avoid redundant updateOptions). */
  private appliedTtsLanguage: LanguageCode | null = null;
  private latestSpeechHandle?: { waitForPlayout(): Promise<void> };

  constructor(options: LiveKitCallSessionOptions) {
    this.ctx = options.jobContext;
    this.logger = options.logger ?? log().child({ room: options.jobContext.room.name });
    this.goodbyeText = options.goodbyeText ?? DEFAULT_GOODBYE_TEXT;
    this.isOutboundCall = options.isOutboundCall;
    this.participantIdentity = options.participantIdentity;
    this.pipeline = options.pipeline;
    this.callRecord = options.callRecord;
    callDebug(
      `[CALL] session.ctor outbound=${this.isOutboundCall} identity=${this.participantIdentity ?? 'none'}`,
      this.logger,
    );
  }

  /** Layman: create the conversation engine and wire STT/LLM/TTS into it. */
  createSession(): voice.AgentSession {
    callDebug('[CALL] session.createSession:start', this.logger);

    const session = new voice.AgentSession({
      // Pipeline components are provider-opaque; AgentSession validates at runtime.
      stt: this.pipeline.stt as never,
      llm: this.pipeline.llm as never,
      tts: this.pipeline.tts as never,
      vad: null,
      turnHandling: {
        turnDetection: 'stt',
        endpointing: {
          minDelay: this.isOutboundCall ? OUTBOUND_ENDPOINTING_MIN_MS : 70,
        },
        // Start drafting the reply before the user fully finishes — big latency win.
        preemptiveGeneration: { enabled: true },
        interruption: {
          // PSTN echo can false-trigger interruptions; keep disabled on phone.
          enabled: !this.isOutboundCall,
          discardAudioIfUninterruptible: this.isOutboundCall,
        },
      },
    });

    this.session = session;
    this.attachTurnLogging(session);
    this.closePromise = this.createClosePromise(session);
    callDebug('[CALL] session.createSession:done', this.logger);
    return session;
  }

  /** Layman: put the agent into the LiveKit room so it can hear and speak. */
  async start(agent: voice.Agent): Promise<void> {
    const session = this.requireSession();
    callDebug('[CALL] session.start:begin', this.logger);

    try {
      await session.start({
        agent,
        room: this.ctx.room,
        inputOptions: this.isOutboundCall
          ? {
              participantIdentity: this.participantIdentity,
              closeOnDisconnect: false,
            }
          : undefined,
        outputOptions: this.isOutboundCall
          ? { syncTranscription: false }
          : undefined,
        record: { audio: true, traces: false, logs: false, transcript: true },
      });
      callDebug('[CALL] session.start:done', this.logger);
    } catch (error) {
      callError(`[CALL] session.start:fail error=${error}`, this.logger);
      throw error;
    }
  }

  /** Layman: tell the session "listen to this phone participant". */
  setParticipant(identity: string): void {
    callDebug(`[CALL] session.setParticipant identity=${identity}`, this.logger);
    this.requireSession()._roomIO?.setParticipant(identity);
    callDebug('[CALL] session.setParticipant:done', this.logger);
  }

  /**
   * Layman: after the phone is connected, wait briefly for "Hello?".
   * If the owner stays silent, introduce Galynest and ask availability (no LLM wait).
   */
  armOpeningGreeting(options: OpeningGreetingOptions): void {
    if (!this.isOutboundCall) return;

    this.clearOpeningGreeting('rearm');
    const waitMs = options.waitMs ?? OWNER_OPENING_WAIT_MS;
    this.openingArmed = true;
    this.openingGreeted = false;
    this.pendingOwnerLanguageGreeting = false;
    this.openingBuildInstructions = options.buildInstructions;
    this.preferredOpeningLanguage = options.preferredLanguage ?? 'en-IN';
    this.languageManager.setLanguage(this.preferredOpeningLanguage);
    // Pre-tune TTS for the silent-path greeting language.
    this.setSpokenLanguage(this.preferredOpeningLanguage, 'opening_armed');

    callDebug(
      `[CALL] session.opening:armed waitMs=${waitMs} preferredLang=${this.preferredOpeningLanguage}`,
      this.logger,
    );

    this.openingTimer = setTimeout(() => {
      this.openingTimer = undefined;
      if (
        !this.openingArmed ||
        this.hangupStarted ||
        this.openingGreeted ||
        this.pendingOwnerLanguageGreeting
      ) {
        callDebug('[CALL] session.opening:skip_timeout', this.logger);
        return;
      }
      this.openingArmed = false;
      this.generateOpeningReply(this.preferredOpeningLanguage, 'silence_timeout');
    }, waitMs);
  }

  /**
   * Layman: retune the agent's voice to English / Hindi / Kannada.
   * Call this whenever we learn (or the owner switches) their language.
   */
  setSpokenLanguage(language: LanguageCode, reason = 'manual'): void {
    const previous = this.languageManager.getCurrentLanguage();
    this.languageManager.setLanguage(language);

    if (this.appliedTtsLanguage === language) {
      callDebug(
        `[CALL] session.language:unchanged language=${language} reason=${reason}`,
        this.logger,
      );
      return;
    }

    const speaker = applySpokenLanguage(
      this.pipeline.tts,
      language,
      this.pipeline.ttsProvider,
      this.pipeline.elevenLabsVoiceId,
    );
    this.appliedTtsLanguage = language;
    this.callRecord?.transcriptBuilder.addLanguage(language);
    callDebug(
      `[CALL] session.language:switched from=${previous} to=${language} provider=${this.pipeline.ttsProvider} voice=${speaker} reason=${reason}`,
      this.logger,
    );
  }

  getCurrentLanguage(): LanguageCode {
    return this.languageManager.getCurrentLanguage();
  }

  recordOwnerOutcome(outcome: OwnerOutcome, summary: string): void {
    this.callRecord?.recordOwnerOutcome(outcome, summary);
    callDebug(
      `[CALL] session.outcome:recorded outcome=${outcome} summary="${summary}"`,
      this.logger,
    );
  }

  /** Ask the LLM to generate the opening intro (no hardcoded spoken text). */
  private generateOpeningReply(language: LanguageCode, reason: string): void {
    if (this.openingGreeted || this.hangupStarted) return;
    this.openingGreeted = true;
    this.setSpokenLanguage(language, `opening_${reason}`);

    const instructions =
      this.openingBuildInstructions?.(language) ??
      `Introduce yourself briefly and ask if the property is still available for rent. Speak in ${language}.`;

    callDebug(
      `[CALL] session.opening:generate_reply reason=${reason} language=${language}`,
      this.logger,
    );

    try {
      this.requireSession().generateReply({
        instructions,
        toolChoice: 'none',
        allowInterruptions: true,
      });
    } catch (error) {
      callError(`[CALL] session.opening:generate_fail error=${error}`, this.logger);
    }
  }


  /**
   * Layman: thank the owner and hang up — scheduled after the availability tool.
   * We intentionally do not wait for the parent speech handle: after a tool-only
   * turn, LiveKit can sit in "speaking" forever with no playout completion.
   */
  scheduleHangup(outcome?: AvailabilityOutcome): void {
    if (this.hangupStarted || this.hangupScheduled) {
      callDebug('[CALL] session.scheduleHangup:skip already_scheduled', this.logger);
      return;
    }
    this.availabilityOutcome = outcome;
    this.hangupScheduled = true;
    this.clearOpeningGreeting('hangup');
    callDebug(`[CALL] session.scheduleHangup:deferred_ms=${HANGUP_DEFER_MS}`, this.logger);

    setTimeout(() => {
      callDebug('[CALL] session.scheduleHangup:defer_fired', this.logger);
      void this.playGoodbyeAndHangup();
    }, HANGUP_DEFER_MS);
  }

  /** @deprecated Use {@link scheduleHangup}. */
  afterSpeechComplete(_speechHandle?: { addDoneCallback(cb: () => void): void }): void {
    this.scheduleHangup();
  }

  /** Layman: keep the worker parked until the call fully ends. */
  waitUntilClosed(): Promise<void> {
    callDebug('[CALL] session.waitUntilClosed:waiting', this.logger);
    return this.closePromise ?? Promise.resolve();
  }

  private clearOpeningGreeting(reason: string): void {
    if (this.openingTimer) {
      clearTimeout(this.openingTimer);
      this.openingTimer = undefined;
    }
    if (this.openingArmed) {
      this.openingArmed = false;
      callDebug(`[CALL] session.opening:cancel reason=${reason}`, this.logger);
    }
  }

  private attachTurnLogging(session: voice.AgentSession): void {
    let agentState: voice.AgentState = 'initializing';
    let turnCommitTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTurnCommitTimer = () => {
      if (turnCommitTimer) {
        clearTimeout(turnCommitTimer);
        turnCommitTimer = undefined;
      }
    };

    const canCommitUserTurn = () =>
      agentState !== 'thinking' && agentState !== 'speaking';

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      agentState = ev.newState;
      callDebug(`[CALL] session.state ${ev.oldState} -> ${ev.newState}`, this.logger);
      if (ev.newState === 'thinking' || ev.newState === 'speaking') {
        clearTurnCommitTimer();
        this.clearOpeningGreeting(`agent_state_${ev.newState}`);
      }
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      this.latestSpeechHandle = ev.speechHandle;
      callDebug(
        `[CALL] session.speech_created id=${ev.speechHandle.id} source=${ev.source}`,
        this.logger,
      );
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      callError('[CALL] session.error', this.logger, { error: ev.error });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.transcript.trim()) {
        this.callRecord?.transcriptBuilder.addUserTranscript(ev.transcript, {
          isFinal: ev.isFinal,
          language: ev.language,
          source: 'stt',
        });
      }

      if (!this.isOutboundCall || !ev.transcript.trim()) {
        return;
      }

      const previousLanguage = this.languageManager.getCurrentLanguage();
      const resolved = this.languageManager.resolveSpokenLanguage(
        ev.transcript,
        ev.language,
      );

      callDebug(
        `[CALL] session.language:detected resolved=${resolved ?? 'keep'} prev=${previousLanguage} sttLang=${ev.language ?? 'null'} final=${ev.isFinal} transcript="${ev.transcript}"`,
        this.logger,
      );

      // Only retune TTS on final transcripts with a clear language switch.
      if (ev.isFinal && resolved) {
        this.setSpokenLanguage(resolved, 'stt_final');
      }

      // Opening window: cancel silence timer and let the LLM answer the owner's first turn.
      if ((this.openingArmed || this.pendingOwnerLanguageGreeting) && !this.openingGreeted) {
        if (this.openingArmed) {
          this.clearOpeningGreeting('owner_spoke');
          this.pendingOwnerLanguageGreeting = true;
        }
        if (ev.isFinal) {
          this.pendingOwnerLanguageGreeting = false;
          this.openingGreeted = true;
          callDebug(
            '[CALL] session.opening:owner_spoke_let_llm_reply',
            this.logger,
          );
        }
        // Fall through so the normal turn commit can trigger generateReply.
      }

      if (!ev.isFinal) {
        return;
      }

      callDebug(`[CALL] session.stt:final transcript="${ev.transcript}"`, this.logger);

      if (this.skipNextTurnCommit) {
        this.skipNextTurnCommit = false;
        callDebug('[CALL] session.turn:commit_skipped reason=opening_greeting', this.logger);
        return;
      }

      clearTurnCommitTimer();
      turnCommitTimer = setTimeout(() => {
        turnCommitTimer = undefined;
        if (canCommitUserTurn()) {
          callDebug('[CALL] session.turn:commit', this.logger);
          session.commitUserTurn();
        } else {
          callDebug(`[CALL] session.turn:commit_skipped state=${agentState}`, this.logger);
        }
      }, TURN_COMMIT_FALLBACK_MS);
    });
  }

  private createClosePromise(session: voice.AgentSession): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveClose = resolve;

      session.on(voice.AgentSessionEventTypes.Close, (ev) => {
        callDebug(`[CALL] session.close:event reason=${String(ev.reason)}`, this.logger);
        void this.finalizeHangup(String(ev.reason));
      });
    });
  }

  /**
   * Wait for the model-generated closing (from the tool reply), then hang up.
   * Fallback to a short scripted line only if no closing speech starts.
   *
   * Always shut down with drain:false and delete the room as a hard hangup.
   */
  private async playGoodbyeAndHangup(): Promise<void> {
    if (this.hangupStarted) {
      callDebug('[CALL] session.goodbye:skip already_started', this.logger);
      return;
    }
    this.hangupStarted = true;
    this.clearOpeningGreeting('goodbye');

    const session = this.requireSession();
    const language = this.languageManager.getCurrentLanguage();
    this.setSpokenLanguage(language, 'goodbye');
    const ttsSpeed = getSettings().ttsSpeed;
    const sipDrainMs = Math.round(
      GOODBYE_SIP_DRAIN_GRACE_MS / Math.min(1, Math.max(0.5, ttsSpeed)),
    );

    let goodbyeTimedOut = false;

    try {
      if (this.goodbyeText !== DEFAULT_GOODBYE_TEXT) {
        callDebug(
          `[CALL] session.goodbye:say_custom language=${language} text="${this.goodbyeText}"`,
          this.logger,
        );
        this.callRecord?.transcriptBuilder.addAssistantText(this.goodbyeText, 'closing');
        const speech = session.say(this.goodbyeText, { allowInterruptions: false });
        goodbyeTimedOut = await raceWithTimeout(
          speech.waitForPlayout(),
          GOODBYE_PLAYOUT_TIMEOUT_MS,
        );
      } else if (this.availabilityOutcome) {
        // The existing speech handle owns the complete LLM turn, including the
        // post-tool closing. Await that exact handle; never race it with another
        // generated/scripted closing, which would queue duplicate audio.
        if (this.latestSpeechHandle) {
          callDebug(
            `[CALL] session.goodbye:await_original_reply language=${language} outcome=${this.availabilityOutcome}`,
            this.logger,
          );
          goodbyeTimedOut = await raceWithTimeout(
            this.latestSpeechHandle.waitForPlayout(),
            GOODBYE_PLAYOUT_TIMEOUT_MS,
          );
        } else {
          const fallback = availabilityClosing(this.availabilityOutcome, language);
          callWarn(
            `[CALL] session.goodbye:fallback_say reason=no_speech_handle text="${fallback}"`,
            this.logger,
          );
          this.callRecord?.transcriptBuilder.addAssistantText(fallback, 'closing');
          const speech = session.say(fallback, { allowInterruptions: false });
          goodbyeTimedOut = await raceWithTimeout(
            speech.waitForPlayout(),
            GOODBYE_PLAYOUT_TIMEOUT_MS,
          );
        }
      } else {
        const goodbyeText = goodbyeForLanguage(language);
        callDebug(
          `[CALL] session.goodbye:say_fallback language=${language} text="${goodbyeText}"`,
          this.logger,
        );
        this.callRecord?.transcriptBuilder.addAssistantText(goodbyeText, 'closing');
        const speech = session.say(goodbyeText, { allowInterruptions: false });
        goodbyeTimedOut = await raceWithTimeout(
          speech.waitForPlayout(),
          GOODBYE_PLAYOUT_TIMEOUT_MS,
        );
      }

      callDebug(
        `[CALL] session.goodbye:play_result timedOut=${goodbyeTimedOut} speed=${ttsSpeed} drainMs=${sipDrainMs}`,
        this.logger,
      );
      if (!goodbyeTimedOut) {
        await sleep(sipDrainMs);
      }
    } catch (error) {
      callError(`[CALL] session.goodbye:play_fail error=${error}`, this.logger);
    }

    if (goodbyeTimedOut) {
      try {
        callDebug('[CALL] session.goodbye:interrupt_after_timeout', this.logger);
        session.interrupt({ force: true });
      } catch (error) {
        callWarn(
          `[CALL] session.goodbye:interrupt_after_timeout_fail error=${error}`,
          this.logger,
        );
      }
    }

    await sleep(50);

    callDebug('[CALL] session.goodbye:shutdown_start drain=false', this.logger);
    session.shutdown({ drain: false, reason: 'availability confirmed' });
    callDebug('[CALL] session.goodbye:shutdown_requested', this.logger);

    await this.finalizeHangup('after_shutdown');

    setTimeout(() => {
      if (this.closeResolved && this.roomDeleted) return;
      callWarn(
        `[CALL] session.close:fallback_timeout ms=${CLOSE_FALLBACK_TIMEOUT_MS}`,
        this.logger,
      );
      void this.finalizeHangup('close_fallback_timeout');
    }, CLOSE_FALLBACK_TIMEOUT_MS);
  }

  /** Delete room + shut down job. Idempotent hard hangup. */
  private async finalizeHangup(reason: string): Promise<void> {
    if (this.closeResolved) {
      callDebug(
        `[CALL] session.finalizeHangup:skip already_done reason=${reason}`,
        this.logger,
      );
      return;
    }
    this.closeResolved = true;

    callDebug(`[CALL] session.finalizeHangup:start reason=${reason}`, this.logger);

    if (!this.roomDeleted) {
      this.roomDeleted = true;
      try {
        callDebug('[CALL] session.finalizeHangup:deleteRoom_start', this.logger);
        await this.ctx.deleteRoom();
        callDebug('[CALL] session.finalizeHangup:deleteRoom_done', this.logger);
      } catch (error) {
        callError(
          `[CALL] session.finalizeHangup:deleteRoom_fail error=${error}`,
          this.logger,
        );
      }
    }

    try {
      const session = this.session;
      let report: ReturnType<JobContext['makeSessionReport']> | undefined;
      if (session) {
        report = this.ctx.makeSessionReport(session);
        if (report.audioRecordingPath) {
          callDebug(
            `[CALL] session.finalizeHangup:recording path=${report.audioRecordingPath}`,
            this.logger,
          );
        }
      }
      await this.persistCallLog(report);
    } catch (error) {
      callWarn(`[CALL] session.finalizeHangup:report_fail error=${error}`, this.logger);
    }

    const jobCtx = getJobContext(false) ?? this.ctx;
    callDebug('[CALL] session.finalizeHangup:job_shutdown', this.logger);
    jobCtx.shutdown(reason);

    callDebug('[CALL] session.finalizeHangup:resolved', this.logger);
    this.resolveClose?.();
  }

  private async persistCallLog(
    report?: ReturnType<JobContext['makeSessionReport']>,
  ): Promise<void> {
    if (this.persistStarted || !this.callRecord) {
      return;
    }
    this.persistStarted = true;

    const snapshot = this.callRecord.finalize(report ?? null);
    callDebug(
      `[CALL] session.persist:start job=${snapshot.jobId} outcome=${snapshot.ownerOutcome} success=${snapshot.success} languages=${snapshot.languages.join(',')}`,
      this.logger,
    );

    await safeCompleteCallLog(snapshot);
    try {
      await saveCallResultSnapshot(snapshot);
      callDebug(`[CALL] session.persist:file_saved job=${snapshot.jobId}`, this.logger);
    } catch (error) {
      callWarn(`[CALL] session.persist:file_fail job=${snapshot.jobId} error=${error}`, this.logger);
    }
  }

  private requireSession(): voice.AgentSession {
    if (!this.session) {
      throw new Error('LiveKitCallSession.createSession() must be called first');
    }
    return this.session;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function raceWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise.then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    return result === 'timeout';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
