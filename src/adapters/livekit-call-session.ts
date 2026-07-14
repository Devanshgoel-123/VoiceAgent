import { getJobContext, type JobContext, log, voice } from '@livekit/agents';
import { callDebug, callError, callWarn } from '../core/call-logger.js';
import {
  LanguageManager,
  type LanguageCode,
} from '../core/language-manager.js';
import { applySpokenLanguage } from './spoken-language.js';
import type { VoicePipelineBundle } from './voice-pipeline.js';

export const DEFAULT_GOODBYE_TEXT = 'Thank you for confirming. Have a great day!';

export function goodbyeForLanguage(language: LanguageCode): string {
  if (language === 'hi-IN') {
    return 'पुष्टि करने के लिए धन्यवाद। आपका दिन शुभ हो!';
  }
  if (language === 'kn-IN') {
    return 'ದೃಢೀಕರಿಸಿದಕ್ಕಾಗಿ ಧನ್ಯವಾದಗಳು. ನಿಮಗೆ ಶುಭ ದಿನವಾಗಲಿ!';
  }
  return DEFAULT_GOODBYE_TEXT;
}
/** Covers ElevenLabs HTTP generation plus the full spoken goodbye. */
export const GOODBYE_PLAYOUT_TIMEOUT_MS = 10_000;
/** Last SIP/PSTN packets can trail LiveKit's local playout completion. */
export const GOODBYE_SIP_DRAIN_GRACE_MS = 1_000;
/** Leave the tool stack, then interrupt any stuck post-tool TTS and hang up. */
export const HANGUP_DEFER_MS = 300;
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
   * After availability is recorded: thank the owner, shut down the session, hang up.
   * Idempotent. Does NOT wait for the parent tool speech handle — that handle often
   * never completes when post-tool TTS hangs in "speaking".
   */
  scheduleHangup(): void;

  /**
   * Switch TTS (+ tracked language) so greeting/replies match the owner.
   * Safe to call on every turn; no-ops when language is unchanged.
   */
  setSpokenLanguage(language: LanguageCode, reason?: string): void;
}

export interface OpeningGreetingOptions {
  /** Max silence after mic is ready before the agent introduces itself. */
  waitMs?: number;
  /** Fallback language when the owner stays silent (job preferred_language or en-IN). */
  preferredLanguage?: LanguageCode;
  /** Build the spoken opening line for a detected/preferred language. */
  buildText: (language: LanguageCode) => string;
}

export interface LiveKitCallSessionOptions {
  jobContext: JobContext;
  pipeline: VoicePipelineBundle;
  isOutboundCall: boolean;
  participantIdentity?: string;
  goodbyeText?: string;
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

  private session?: voice.AgentSession;
  private hangupStarted = false;
  private hangupScheduled = false;
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
  private openingBuildText?: (language: LanguageCode) => string;
  private preferredOpeningLanguage: LanguageCode = 'en-IN';
  private readonly languageManager = new LanguageManager('en-IN');
  /** Last language pushed into Sarvam TTS (avoid redundant updateOptions). */
  private appliedTtsLanguage: LanguageCode | null = null;

  constructor(options: LiveKitCallSessionOptions) {
    this.ctx = options.jobContext;
    this.logger = options.logger ?? log().child({ room: options.jobContext.room.name });
    this.goodbyeText = options.goodbyeText ?? DEFAULT_GOODBYE_TEXT;
    this.isOutboundCall = options.isOutboundCall;
    this.participantIdentity = options.participantIdentity;
    this.pipeline = options.pipeline;
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
        record: { audio: true, traces: false, logs: false, transcript: false },
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
   * If the owner stays silent, introduce Gullynest and ask availability (no LLM wait).
   */
  armOpeningGreeting(options: OpeningGreetingOptions): void {
    if (!this.isOutboundCall) return;

    this.clearOpeningGreeting('rearm');
    const waitMs = options.waitMs ?? OWNER_OPENING_WAIT_MS;
    this.openingArmed = true;
    this.openingGreeted = false;
    this.pendingOwnerLanguageGreeting = false;
    this.openingBuildText = options.buildText;
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
      this.speakOpeningGreeting(this.preferredOpeningLanguage, 'silence_timeout');
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
    );
    this.appliedTtsLanguage = language;
    callDebug(
      `[CALL] session.language:switched from=${previous} to=${language} provider=${this.pipeline.ttsProvider} voice=${speaker} reason=${reason}`,
      this.logger,
    );
  }

  /** Speak the fixed multilingual intro once (TTS already set to that language). */
  private speakOpeningGreeting(language: LanguageCode, reason: string): void {
    if (this.openingGreeted || this.hangupStarted) return;
    this.openingGreeted = true;
    this.setSpokenLanguage(language, `opening_${reason}`);

    const text =
      this.openingBuildText?.(language) ??
      `Hello, this is Gullynest. Is the property still available for rent?`;

    callDebug(
      `[CALL] session.opening:speak reason=${reason} language=${language} text="${text}"`,
      this.logger,
    );

    try {
      this.requireSession().say(text, { allowInterruptions: true });
    } catch (error) {
      callError(`[CALL] session.opening:say_fail error=${error}`, this.logger);
    }
  }


  /**
   * Layman: thank the owner and hang up — scheduled after the availability tool.
   * We intentionally do not wait for the parent speech handle: after a tool-only
   * turn, LiveKit can sit in "speaking" forever with no playout completion.
   */
  scheduleHangup(): void {
    if (this.hangupStarted || this.hangupScheduled) {
      callDebug('[CALL] session.scheduleHangup:skip already_scheduled', this.logger);
      return;
    }
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
      callDebug(
        `[CALL] session.speech_created id=${ev.speechHandle.id} source=${ev.source}`,
        this.logger,
      );
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      callError('[CALL] session.error', this.logger, { error: ev.error });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!this.isOutboundCall || !ev.transcript.trim()) {
        return;
      }

      const previousLanguage = this.languageManager.getCurrentLanguage();
      const fromStt = LanguageManager.normalizeLanguageCode(ev.language ?? undefined);
      const fromText = this.languageManager.detectFromText(ev.transcript);
      const language = fromStt ?? fromText.language;

      callDebug(
        `[CALL] session.language:detected language=${language} prev=${previousLanguage} sttLang=${ev.language ?? 'null'} final=${ev.isFinal} transcript="${ev.transcript}"`,
        this.logger,
      );

      // Retune TTS whenever the owner’s language is known / changes mid-call.
      this.setSpokenLanguage(language, ev.isFinal ? 'stt_final' : 'stt_interim');

      // Opening window: cancel silence timer; on final transcript greet in their language.
      if ((this.openingArmed || this.pendingOwnerLanguageGreeting) && !this.openingGreeted) {
        if (this.openingArmed) {
          this.clearOpeningGreeting('owner_spoke');
          this.pendingOwnerLanguageGreeting = true;
        }
        if (ev.isFinal) {
          this.pendingOwnerLanguageGreeting = false;
          this.skipNextTurnCommit = true;
          this.speakOpeningGreeting(language, 'owner_spoke');
        }
        return;
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
   * Layman: cut any stuck speech, say thank-you (best effort), then force-close.
   *
   * Important: LiveKit `shutdown({ drain: true })` awaits currentSpeech.waitForPlayout().
   * If goodbye TTS hangs, Close never fires and the SIP call never drops.
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

    try {
      callDebug('[CALL] session.goodbye:interrupt_stuck_speech', this.logger);
      session.interrupt({ force: true });
    } catch (error) {
      callWarn(`[CALL] session.goodbye:interrupt_fail error=${error}`, this.logger);
    }

    await sleep(150);

    let goodbyeTimedOut = false;
    try {
      const language = this.languageManager.getCurrentLanguage();
      this.setSpokenLanguage(language, 'goodbye');
      const goodbyeText = this.goodbyeText === DEFAULT_GOODBYE_TEXT
        ? goodbyeForLanguage(language)
        : this.goodbyeText;
      callDebug(
        `[CALL] session.goodbye:play_start language=${language} text="${goodbyeText}"`,
        this.logger,
      );
      const speech = session.say(goodbyeText, { allowInterruptions: false });
      goodbyeTimedOut = await raceWithTimeout(
        speech.waitForPlayout(),
        GOODBYE_PLAYOUT_TIMEOUT_MS,
      );
      if (goodbyeTimedOut) {
        callWarn('[CALL] session.goodbye:play_timeout', this.logger);
      } else {
        callDebug('[CALL] session.goodbye:play_done', this.logger);
        callDebug(
          `[CALL] session.goodbye:sip_drain_start ms=${GOODBYE_SIP_DRAIN_GRACE_MS}`,
          this.logger,
        );
        await sleep(GOODBYE_SIP_DRAIN_GRACE_MS);
        callDebug('[CALL] session.goodbye:sip_drain_done', this.logger);
      }
    } catch (error) {
      callError(`[CALL] session.goodbye:play_fail error=${error}`, this.logger);
    }

    // Do not interrupt a goodbye that completed: SIP may still be flushing it.
    // Force interruption remains the escape hatch for a genuinely wedged TTS.
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
      if (session) {
        const report = this.ctx.makeSessionReport(session);
        if (report.audioRecordingPath) {
          callDebug(
            `[CALL] session.finalizeHangup:recording path=${report.audioRecordingPath}`,
            this.logger,
          );
        }
      }
    } catch (error) {
      callWarn(`[CALL] session.finalizeHangup:report_fail error=${error}`, this.logger);
    }

    const jobCtx = getJobContext(false) ?? this.ctx;
    callDebug('[CALL] session.finalizeHangup:job_shutdown', this.logger);
    jobCtx.shutdown(reason);

    callDebug('[CALL] session.finalizeHangup:resolved', this.logger);
    this.resolveClose?.();
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
