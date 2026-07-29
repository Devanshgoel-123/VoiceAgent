import { getJobContext, type JobContext, log, voice } from '@livekit/agents';
import {
  CLOSE_FALLBACK_TIMEOUT_MS,
  GOODBYE_PLAYOUT_TIMEOUT_MS,
  GOODBYE_SIP_DRAIN_GRACE_MS,
  HANGUP_DEFER_MS,
  OUTBOUND_ENDPOINTING_MIN_MS,
  OWNER_OPENING_WAIT_MS,
  OWNER_RESPONSE_TIMEOUT_MS,
  TURN_COMMIT_FALLBACK_MS,
} from '../config/call-config.js';
import { getSettings } from '../config/settings.js';
import { callDebug, callError, callInfo, callWarn } from '../core/call-logger.js';
import { fireAndForget } from '../core/process-safety.js';
import {
  LanguageManager,
  type LanguageCode,
} from '../core/language-manager.js';
import { isOwnershipMismatch } from '../core/owner-intent.js';
import type { OwnerOutcome } from '../jobs/call-log-types.js';
import type { CallLogSnapshot } from '../jobs/call-log-types.js';
import { CallSessionRecord } from '../jobs/call-session-record.js';
import {
  availabilityClosing,
  goodbyeForLanguage,
  ownershipMismatchClosing,
  type AvailabilityOutcome,
} from './closing-messages.js';
import { applySpokenLanguage } from './spoken-language.js';
import {
  enforceSelectedSpeechLanguage,
  filterToolCallMarkup,
  normalizeSpeechText,
} from './tts-text-transforms.js';
import type { VoicePipelineBundle } from './voice-pipeline.js';

export type { AvailabilityOutcome };
export {
  availabilityClosing,
  goodbyeForLanguage,
  openingForLanguage,
  ownershipMismatchClosing,
} from './closing-messages.js';
export type { OpeningScriptParams } from './closing-messages.js';
export { OWNER_OPENING_WAIT_MS } from '../config/call-config.js';

export interface CallLifecycle {
  scheduleHangup(outcome?: AvailabilityOutcome): void;
  setSpokenLanguage(language: LanguageCode, reason?: string): void;
  getCurrentLanguage(): LanguageCode;
  getLastOwnerTranscript(): string | undefined;
  /** Full assembled owner turn committed to the LLM context. */
  setCommittedOwnerTranscript?(transcript: string): void;
  getCommittedOwnerTurnSequence?(): number;
  recordOwnerOutcome(outcome: OwnerOutcome, summary: string): void;
  /** Owner explicitly asked not to be called again. */
  recordDoNotCall(reason: string): void;
}

export interface OpeningGreetingOptions {
  waitMs?: number;
  preferredLanguage?: LanguageCode;
  /** Scripted opening text for the given language (TTS only — no LLM). */
  buildOpeningText: (language: LanguageCode) => string;
}

export interface LiveKitCallSessionOptions {
  jobContext: JobContext;
  pipeline: VoicePipelineBundle;
  isOutboundCall: boolean;
  participantIdentity?: string;
  callRecord?: CallSessionRecord;
  logger?: ReturnType<typeof log>;
  /** Composition root persists call results after the session closes. */
  onPersist?: (snapshot: CallLogSnapshot) => Promise<void>;
}

/** Debounces final STT fragments while allowing continued speech to cancel. */
export class OwnerTurnCommitScheduler {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly delayMs: number) {}

  schedule(commit: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      commit();
    }, this.delayMs);
  }

  cancel(): boolean {
    if (!this.timer) return false;
    clearTimeout(this.timer);
    this.timer = undefined;
    return true;
  }
}

/** One outbound call: AgentSession lifecycle, language, greeting, hangup, persist. */
export class LiveKitCallSession implements CallLifecycle {
  private readonly ctx: JobContext;
  private readonly logger: ReturnType<typeof log>;
  private readonly isOutboundCall: boolean;
  private readonly participantIdentity?: string;
  private readonly pipeline: VoicePipelineBundle;
  private readonly callRecord?: CallSessionRecord;
  private readonly onPersist?: (snapshot: CallLogSnapshot) => Promise<void>;
  private readonly languageManager = new LanguageManager('en-IN');

  private session?: voice.AgentSession;
  private hangupScheduled = false;
  private hangupStarted = false;
  private roomDeleted = false;
  private closeResolved = false;
  private availabilityOutcome?: AvailabilityOutcome;
  private ownershipMismatch = false;
  private resolveClose?: () => void;
  private closePromise?: Promise<void>;

  private openingTimer?: ReturnType<typeof setTimeout>;
  private openingArmed = false;
  private openingGreeted = false;
  private pendingOwnerLanguageGreeting = false;
  private openingBuildText?: (language: LanguageCode) => string;
  private preferredOpeningLanguage: LanguageCode = 'en-IN';
  private appliedTtsLanguage: LanguageCode | null = null;
  private ownerResponseTimer?: ReturnType<typeof setTimeout>;
  private sessionErrorCount = 0;
  private ownerRespondedAfterOpening = false;
  private lastFinalOwnerTranscript?: string;
  private lastCommittedOwnerTranscript?: string;
  private committedOwnerTurnSequence = 0;
  private pendingLanguageSwitch: LanguageCode | null = null;
  private pendingLanguageSwitchCount = 0;

  constructor(options: LiveKitCallSessionOptions) {
    this.ctx = options.jobContext;
    this.logger = options.logger ?? log().child({ room: options.jobContext.room.name });
    this.isOutboundCall = options.isOutboundCall;
    this.participantIdentity = options.participantIdentity;
    this.pipeline = options.pipeline;
    this.callRecord = options.callRecord;
    this.onPersist = options.onPersist;
  }

  createSession(): voice.AgentSession {
    const session = new voice.AgentSession({
      stt: this.pipeline.stt as never,
      llm: this.pipeline.llm as never,
      tts: this.pipeline.tts as never,
      vad: null,
      ttsTextTransforms: [
        'filter_markdown',
        filterToolCallMarkup,
        normalizeSpeechText,
        (input) =>
          enforceSelectedSpeechLanguage(input, () =>
            this.languageManager.getCurrentLanguage(),
          ),
        'filter_emoji',
      ],
      turnHandling: {
        turnDetection: 'stt',
        endpointing: {
          minDelay: this.isOutboundCall ? OUTBOUND_ENDPOINTING_MIN_MS : 70,
        },
        preemptiveGeneration: { enabled: false },
        interruption: {
          enabled: !this.isOutboundCall,
          discardAudioIfUninterruptible: this.isOutboundCall,
        },
      },
    });

    this.session = session;
    this.attachSessionEvents(session);
    this.closePromise = this.createClosePromise(session);
    return session;
  }

  async start(agent: voice.Agent): Promise<void> {
    const session = this.requireSession();
    try {
      await session.start({
        agent,
        room: this.ctx.room,
        inputOptions: this.isOutboundCall
          ? { participantIdentity: this.participantIdentity, closeOnDisconnect: false }
          : undefined,
        outputOptions: this.isOutboundCall ? { syncTranscription: false } : undefined,
        record: { audio: true, traces: false, logs: false, transcript: true },
      });
    } catch (error) {
      callError(`session.start failed: ${error}`, this.logger);
      throw error;
    }
  }

  setParticipant(identity: string): void {
    this.requireSession()._roomIO?.setParticipant(identity);
  }

  armOpeningGreeting(options: OpeningGreetingOptions): void {
    if (!this.isOutboundCall) return;

    this.clearOpeningGreeting();
    const waitMs = options.waitMs ?? OWNER_OPENING_WAIT_MS;
    this.openingArmed = true;
    this.openingGreeted = false;
    this.pendingOwnerLanguageGreeting = false;
    this.openingBuildText = options.buildOpeningText;
    this.preferredOpeningLanguage = options.preferredLanguage ?? 'en-IN';
    this.languageManager.setLanguage(this.preferredOpeningLanguage);
    this.setSpokenLanguage(this.preferredOpeningLanguage, 'opening_armed');

    this.openingTimer = setTimeout(() => {
      this.openingTimer = undefined;
      if (
        !this.openingArmed ||
        this.hangupStarted ||
        this.openingGreeted ||
        this.pendingOwnerLanguageGreeting
      ) {
        return;
      }
      this.openingArmed = false;
      this.speakOpening(this.preferredOpeningLanguage);
    }, waitMs);
  }

  setSpokenLanguage(language: LanguageCode, reason = 'manual'): void {
    const previous = this.languageManager.getCurrentLanguage();
    this.languageManager.setLanguage(language);

    if (this.appliedTtsLanguage === language) return;

    applySpokenLanguage(
      this.pipeline.tts,
      language,
      this.pipeline.ttsProvider,
      this.pipeline.elevenLabsVoiceId,
      this.pipeline.sarvamSpeaker,
    );
    this.appliedTtsLanguage = language;
    this.callRecord?.transcriptBuilder.addLanguage(language);

    if (previous === language || previous === 'unknown') {
      callInfo(`language: ${language} (${reason})`, this.logger);
    } else {
      callInfo(`language: ${previous} → ${language} (${reason})`, this.logger);
    }
  }

  getCurrentLanguage(): LanguageCode {
    return this.languageManager.getCurrentLanguage();
  }

  getLastOwnerTranscript(): string | undefined {
    return this.lastCommittedOwnerTranscript ?? this.lastFinalOwnerTranscript;
  }

  setCommittedOwnerTranscript(transcript: string): void {
    const normalized = transcript.trim();
    if (!normalized) return;
    this.lastCommittedOwnerTranscript = normalized;
    this.committedOwnerTurnSequence += 1;
  }

  getCommittedOwnerTurnSequence(): number {
    return this.committedOwnerTurnSequence;
  }

  private shouldApplyLanguageSwitch(
    language: LanguageCode,
    transcript: string,
  ): boolean {
    if (LanguageManager.hasStrongLanguageSwitchEvidence(transcript)) {
      this.resetPendingLanguageSwitch();
      return true;
    }

    if (this.pendingLanguageSwitch === language) {
      this.pendingLanguageSwitchCount += 1;
    } else {
      this.pendingLanguageSwitch = language;
      this.pendingLanguageSwitchCount = 1;
    }

    if (this.pendingLanguageSwitchCount < 2) return false;
    this.resetPendingLanguageSwitch();
    return true;
  }

  private resetPendingLanguageSwitch(): void {
    this.pendingLanguageSwitch = null;
    this.pendingLanguageSwitchCount = 0;
  }

  recordOwnerOutcome(outcome: OwnerOutcome, summary: string): void {
    this.callRecord?.recordOwnerOutcome(outcome, summary);
  }

  recordDoNotCall(reason: string): void {
    this.callRecord?.recordDoNotCall(reason);
    this.callRecord?.recordOwnerOutcome(
      'other',
      `Owner opted out of future calls (${reason}).`,
    );
    callInfo(`opt-out: recorded reason="${truncateForLog(reason)}"`, this.logger);
  }

  scheduleHangup(outcome?: AvailabilityOutcome): void {
    if (this.hangupStarted || this.hangupScheduled) return;
    this.availabilityOutcome = outcome;
    this.hangupScheduled = true;
    this.clearOpeningGreeting();
    callInfo(`hangup: scheduled outcome=${outcome ?? 'none'}`, this.logger);
    setTimeout(
      () =>
        fireAndForget('playGoodbyeAndHangup', () => this.playGoodbyeAndHangup(), this.logger),
      HANGUP_DEFER_MS,
    );
  }

  waitUntilClosed(): Promise<void> {
    return this.closePromise ?? Promise.resolve();
  }

  /** Scripted opening via TTS — no LLM round-trip. */
  private speakOpening(language: LanguageCode): void {
    if (this.openingGreeted || this.hangupStarted) return;
    this.openingGreeted = true;
    this.setSpokenLanguage(language, 'opening');

    const text =
      this.openingBuildText?.(language) ??
      `Hi, I'm calling about a property. Is it still available for rent?`;

    callInfo(`opening: say language=${language}`, this.logger);
    this.callRecord?.transcriptBuilder.addAssistantText(text, 'opening');

    try {
      this.requireSession().say(text, {
        allowInterruptions: !this.isOutboundCall,
      });
    } catch (error) {
      callError(`opening say failed: ${error}`, this.logger);
    }

    this.armOwnerResponseTimeout();
  }

  private armOwnerResponseTimeout(): void {
    if (!this.isOutboundCall || !this.openingGreeted) return;
    this.clearOwnerResponseTimeout();

    this.ownerResponseTimer = setTimeout(() => {
      this.ownerResponseTimer = undefined;
      if (
        this.hangupScheduled ||
        this.hangupStarted ||
        this.ownerRespondedAfterOpening
      ) {
        return;
      }
      callInfo('owner-response: timeout after opening (inconclusive)', this.logger);
      this.recordOwnerOutcome(
        'unclear',
        'No clear owner response after opening (timeout).',
      );
      this.scheduleHangup();
    }, OWNER_RESPONSE_TIMEOUT_MS);
  }

  private clearOwnerResponseTimeout(): void {
    if (this.ownerResponseTimer) {
      clearTimeout(this.ownerResponseTimer);
      this.ownerResponseTimer = undefined;
    }
  }

  /**
   * Clear yes/no without LLM: record outcome and hang up with scripted closing.
   * Only short, unambiguous answers — long clarifications go to the LLM.
   * Returns true when handled (caller must skip commitUserTurn).
   */
  private tryFastAvailabilityAnswer(transcript: string): boolean {
    if (!this.openingGreeted || this.hangupScheduled || this.hangupStarted) {
      return false;
    }

    if (!LanguageManager.isShortYesNo(transcript)) {
      return false;
    }

    const intent = this.languageManager.detectFromText(transcript);
    if (intent.isAffirmative === true) {
      callInfo(`fast-path: yes heard="${truncateForLog(transcript)}"`, this.logger);
      this.recordOwnerOutcome('yes', `Owner confirmed availability (${transcript}).`);
      this.scheduleHangup('yes');
      return true;
    }
    if (intent.isNegative === true) {
      callInfo(`fast-path: no heard="${truncateForLog(transcript)}"`, this.logger);
      this.recordOwnerOutcome(
        'no',
        `Owner confirmed not available (${transcript}).`,
      );
      this.scheduleHangup('no');
      return true;
    }
    return false;
  }

  private clearOpeningGreeting(): void {
    this.clearOpeningTimer();
    this.clearOwnerResponseTimeout();
  }

  private clearOpeningTimer(): void {
    if (this.openingTimer) {
      clearTimeout(this.openingTimer);
      this.openingTimer = undefined;
    }
    this.openingArmed = false;
  }

  private attachSessionEvents(session: voice.AgentSession): void {
    let agentState: voice.AgentState = 'initializing';
    const turnCommitScheduler = new OwnerTurnCommitScheduler(
      TURN_COMMIT_FALLBACK_MS,
    );

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      agentState = ev.newState;
      callInfo(`agent: ${ev.oldState} → ${ev.newState}`, this.logger);
      if (ev.newState === 'thinking' || ev.newState === 'speaking') {
        turnCommitScheduler.cancel();
        // Agent activity must not cancel the timer waiting for the owner.
        this.clearOpeningTimer();
      }
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'speaking') {
        // A new speech segment means the previous final transcript was only a
        // pause, not the end of the owner's complete thought.
        turnCommitScheduler.cancel();
        this.lastCommittedOwnerTranscript = undefined;
        this.ownerRespondedAfterOpening = false;
        this.armOwnerResponseTimeout();
        callDebug('turn commit: cancelled because owner resumed speaking', this.logger);
      }
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== 'message') return;
      const text = item.textContent?.trim();
      if (!text) return;
      const who =
        item.role === 'user' ? 'owner' : item.role === 'assistant' ? 'agent' : item.role;
      callDebug(`${who}: ${text}`, this.logger);
      if (item.role === 'assistant') {
        this.callRecord?.transcriptBuilder.addAssistantText(text, 'agent');
        this.sessionErrorCount = 0;
      }
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      this.sessionErrorCount += 1;
      callError('session error', this.logger, { error: ev.error });
      if (this.hangupScheduled || this.hangupStarted) return;

      const message = String(ev.error);
      if (this.sessionErrorCount < 2) {
        callWarn('session error: allowing one transient recovery attempt', this.logger);
        this.armOwnerResponseTimeout();
        return;
      }

      this.callRecord?.markFailed(`Repeated session provider error: ${message}`);
      this.scheduleHangup();
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      const transcript = ev.transcript.trim();
      if (!transcript) return;

      if (!this.hangupScheduled && !this.hangupStarted) {
        this.callRecord?.transcriptBuilder.addUserTranscript(ev.transcript, {
          isFinal: ev.isFinal,
          language: ev.language,
          source: 'stt',
        });
      }

      if (!this.isOutboundCall || this.hangupScheduled || this.hangupStarted) return;

      const unsupportedLanguage = ev.isFinal
        ? LanguageManager.detectUnsupportedLanguage(ev.transcript, ev.language)
        : null;
      if (unsupportedLanguage) {
        turnCommitScheduler.cancel();
        session.clearUserTurn();
        this.resetPendingLanguageSwitch();
        this.clearOpeningGreeting();
        this.openingGreeted = true;
        // We handled this turn and are now waiting for a supported-language reply.
        this.ownerRespondedAfterOpening = false;
        this.setSpokenLanguage(
          'en-IN',
          `unsupported_language=${unsupportedLanguage}`,
        );

        const supportText =
          'Sorry, I can only speak English, Hindi, or Kannada. ' +
          'Is the property still available for rent?';
        this.callRecord?.transcriptBuilder.addAssistantText(
          supportText,
          'language_fallback',
        );
        session.say(supportText, { allowInterruptions: false });
        this.armOwnerResponseTimeout();
        return;
      }

      const resolved = this.languageManager.resolveSpokenLanguage(
        ev.transcript,
        ev.language,
      );

      // Only decide language on final turns — log switch vs keep so call status is clear.
      if (ev.isFinal) {
        const current = this.languageManager.getCurrentLanguage();
        const sttHint = ev.language ?? 'null';
        const heard = truncateForLog(ev.transcript);

        if (
          resolved &&
          resolved !== current &&
          this.shouldApplyLanguageSwitch(resolved, ev.transcript)
        ) {
          this.setSpokenLanguage(resolved, `stt heard="${heard}" sttHint=${sttHint}`);
        } else if (resolved && resolved !== current) {
          callInfo(
            `language: keep ${current} (waiting for confirmation of ${resolved}, heard="${heard}" sttHint=${sttHint})`,
            this.logger,
          );
        } else if (resolved && resolved === current) {
          this.resetPendingLanguageSwitch();
          callInfo(
            `language: keep ${current} (confirmed, heard="${heard}" sttHint=${sttHint})`,
            this.logger,
          );
        } else {
          this.resetPendingLanguageSwitch();
          callInfo(
            `language: keep ${current} (no switch, heard="${heard}" sttHint=${sttHint})`,
            this.logger,
          );
        }
      }

      if (!ev.isFinal) return;
      this.lastFinalOwnerTranscript = transcript;

      if (this.openingGreeted) {
        this.ownerRespondedAfterOpening = true;
        this.clearOwnerResponseTimeout();
      }

      if (isOwnershipMismatch(transcript)) {
        this.ownershipMismatch = true;
        this.callRecord?.recordEndReason('ownership_mismatch');
        this.recordOwnerOutcome(
          'other',
          `Ownership mismatch: the callee stated they do not own this property. Owner response: "${transcript}"`,
        );
        this.scheduleHangup();
        return;
      }

      let ownerSpokeBeforeOpening = false;

      // If the owner speaks first, cancel the canned opening and send that turn
      // to the LLM. This prevents identity/language questions being discarded.
      if ((this.openingArmed || this.pendingOwnerLanguageGreeting) && !this.openingGreeted) {
        if (this.openingArmed) {
          this.clearOpeningGreeting();
        }
        this.pendingOwnerLanguageGreeting = false;
        this.openingGreeted = true;
        this.ownerRespondedAfterOpening = true;
        ownerSpokeBeforeOpening = true;
      }

      // Clear yes/no → skip LLM entirely.
      if (!ownerSpokeBeforeOpening && this.tryFastAvailabilityAnswer(ev.transcript)) {
        return;
      }

      // Unclear / other speech → minimum LLM brain.
      turnCommitScheduler.schedule(() => {
        if (
          !this.hangupScheduled &&
          !this.hangupStarted &&
          agentState !== 'thinking' &&
          agentState !== 'speaking'
        ) {
          session.commitUserTurn();
        }
      });
    });
  }

  private createClosePromise(session: voice.AgentSession): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveClose = resolve;
      session.on(voice.AgentSessionEventTypes.Close, (ev) => {
        fireAndForget('finalizeHangup', () => this.finalizeHangup(String(ev.reason)), this.logger);
      });
    });
  }

  /**
   * Play a scripted closing in the owner's last language (no post-tool LLM turn),
   * then shut down and delete the room.
   */
  private async playGoodbyeAndHangup(): Promise<void> {
    if (this.hangupStarted) return;
    this.hangupStarted = true;
    this.clearOpeningGreeting();

    const session = this.requireSession();
    const language =
      this.languageManager.getCurrentLanguage() === 'unknown'
        ? 'en-IN'
        : this.languageManager.getCurrentLanguage();
    this.setSpokenLanguage(language, 'goodbye');
    const ttsSpeed = getSettings().ttsSpeed;
    const sipDrainMs = Math.round(
      GOODBYE_SIP_DRAIN_GRACE_MS / Math.min(1, Math.max(0.5, ttsSpeed)),
    );

    // Cancel any post-tool LLM reply so it cannot speak after / over the closing.
    try {
      session.interrupt({ force: true });
    } catch {
      /* ignore */
    }
    await sleep(100);

    let goodbyeTimedOut = false;

    try {
      const goodbyeText = this.ownershipMismatch
        ? ownershipMismatchClosing(language)
        : this.availabilityOutcome
          ? availabilityClosing(this.availabilityOutcome, language, {
              companyName: getSettings().companyName,
              companyWebsite: getSettings().companyWebsite,
            })
          : goodbyeForLanguage(language);

      callInfo(
        `closing: say language=${language} outcome=${
          this.ownershipMismatch
            ? 'ownership_mismatch'
            : (this.availabilityOutcome ?? 'none')
        }`,
        this.logger,
      );
      this.callRecord?.transcriptBuilder.addAssistantText(goodbyeText, 'closing');
      const speech = session.say(goodbyeText, { allowInterruptions: false });
      goodbyeTimedOut = await raceWithTimeout(
        speech.waitForPlayout(),
        GOODBYE_PLAYOUT_TIMEOUT_MS,
      );

      if (!goodbyeTimedOut) await sleep(sipDrainMs);
    } catch (error) {
      callError(`goodbye failed: ${error}`, this.logger);
    }

    if (goodbyeTimedOut) {
      try {
        session.interrupt({ force: true });
      } catch {
        /* ignore */
      }
    }

    await sleep(50);
    const shutdownReason = this.ownershipMismatch
      ? 'ownership mismatch'
      : this.availabilityOutcome
        ? `availability confirmed: ${this.availabilityOutcome}`
        : 'call completed: inconclusive';
    session.shutdown({ drain: false, reason: shutdownReason });
    await this.finalizeHangup('after_shutdown');

    setTimeout(() => {
      if (this.closeResolved && this.roomDeleted) return;
      fireAndForget(
        'finalizeHangup:fallback',
        () => this.finalizeHangup('close_fallback_timeout'),
        this.logger,
      );
    }, CLOSE_FALLBACK_TIMEOUT_MS);
  }

  private async finalizeHangup(reason: string): Promise<void> {
    if (this.closeResolved) return;
    this.closeResolved = true;

    if (!this.roomDeleted) {
      this.roomDeleted = true;
      try {
        await this.ctx.deleteRoom();
      } catch (error) {
        callError(`deleteRoom failed: ${error}`, this.logger);
      }
    }

    try {
      const session = this.session;
      const report = session ? this.ctx.makeSessionReport(session) : undefined;
      const snapshot = this.callRecord?.finalize(report ?? null);
      if (snapshot && this.onPersist) {
        await this.onPersist(snapshot);
      }
    } catch (error) {
      callWarn(`session persist failed: ${error}`, this.logger);
    }

    const jobCtx = getJobContext(false) ?? this.ctx;
    jobCtx.shutdown(reason);
    this.resolveClose?.();
  }

  private requireSession(): voice.AgentSession {
    if (!this.session) {
      throw new Error('createSession() must be called first');
    }
    return this.session;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateForLog(text: string, max = 80): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
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
