import { getJobContext, type JobContext, log, voice } from '@livekit/agents';
import {
  CLOSE_FALLBACK_TIMEOUT_MS,
  GOODBYE_PLAYOUT_TIMEOUT_MS,
  GOODBYE_SIP_DRAIN_GRACE_MS,
  HANGUP_DEFER_MS,
  OUTBOUND_ENDPOINTING_MIN_MS,
  OWNER_OPENING_WAIT_MS,
  TURN_COMMIT_FALLBACK_MS,
} from '../config/call-config.js';
import { getSettings } from '../config/settings.js';
import { callError, callInfo, callWarn } from '../core/call-logger.js';
import {
  LanguageManager,
  type LanguageCode,
} from '../core/language-manager.js';
import { safeCompleteCallLog } from '../db/call-log-repository.js';
import type { OwnerOutcome } from '../jobs/call-log-types.js';
import { CallSessionRecord } from '../jobs/call-session-record.js';
import { saveCallResultSnapshot } from '../jobs/persist-call-result.js';
import {
  availabilityClosing,
  goodbyeForLanguage,
  type AvailabilityOutcome,
} from './closing-messages.js';
import { applySpokenLanguage } from './spoken-language.js';
import type { VoicePipelineBundle } from './voice-pipeline.js';

export type { AvailabilityOutcome };
export { availabilityClosing, goodbyeForLanguage } from './closing-messages.js';
export { OWNER_OPENING_WAIT_MS } from '../config/call-config.js';

export interface CallLifecycle {
  scheduleHangup(outcome?: AvailabilityOutcome): void;
  setSpokenLanguage(language: LanguageCode, reason?: string): void;
  getCurrentLanguage(): LanguageCode;
  recordOwnerOutcome(outcome: OwnerOutcome, summary: string): void;
}

export interface OpeningGreetingOptions {
  waitMs?: number;
  preferredLanguage?: LanguageCode;
  buildInstructions: (language: LanguageCode) => string;
}

export interface LiveKitCallSessionOptions {
  jobContext: JobContext;
  pipeline: VoicePipelineBundle;
  isOutboundCall: boolean;
  participantIdentity?: string;
  callRecord?: CallSessionRecord;
  logger?: ReturnType<typeof log>;
}

/** One outbound call: AgentSession lifecycle, language, greeting, hangup, persist. */
export class LiveKitCallSession implements CallLifecycle {
  private readonly ctx: JobContext;
  private readonly logger: ReturnType<typeof log>;
  private readonly isOutboundCall: boolean;
  private readonly participantIdentity?: string;
  private readonly pipeline: VoicePipelineBundle;
  private readonly callRecord?: CallSessionRecord;
  private readonly languageManager = new LanguageManager('en-IN');

  private session?: voice.AgentSession;
  private hangupScheduled = false;
  private hangupStarted = false;
  private roomDeleted = false;
  private closeResolved = false;
  private persistStarted = false;
  private availabilityOutcome?: AvailabilityOutcome;
  private resolveClose?: () => void;
  private closePromise?: Promise<void>;

  private openingTimer?: ReturnType<typeof setTimeout>;
  private openingArmed = false;
  private openingGreeted = false;
  private pendingOwnerLanguageGreeting = false;
  private openingBuildInstructions?: (language: LanguageCode) => string;
  private preferredOpeningLanguage: LanguageCode = 'en-IN';
  private appliedTtsLanguage: LanguageCode | null = null;
  private agentState: voice.AgentState = 'initializing';
  private hangupScheduledAt = 0;
  private lastAgentSpeechEndedAt = 0;

  constructor(options: LiveKitCallSessionOptions) {
    this.ctx = options.jobContext;
    this.logger = options.logger ?? log().child({ room: options.jobContext.room.name });
    this.isOutboundCall = options.isOutboundCall;
    this.participantIdentity = options.participantIdentity;
    this.pipeline = options.pipeline;
    this.callRecord = options.callRecord;
  }

  createSession(): voice.AgentSession {
    const session = new voice.AgentSession({
      stt: this.pipeline.stt as never,
      llm: this.pipeline.llm as never,
      tts: this.pipeline.tts as never,
      vad: null,
      turnHandling: {
        turnDetection: 'stt',
        endpointing: {
          minDelay: this.isOutboundCall ? OUTBOUND_ENDPOINTING_MIN_MS : 70,
        },
        preemptiveGeneration: { enabled: true },
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
    this.openingBuildInstructions = options.buildInstructions;
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
      this.generateOpeningReply(this.preferredOpeningLanguage);
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

  recordOwnerOutcome(outcome: OwnerOutcome, summary: string): void {
    this.callRecord?.recordOwnerOutcome(outcome, summary);
  }

  scheduleHangup(outcome?: AvailabilityOutcome): void {
    if (this.hangupStarted || this.hangupScheduled) return;
    this.availabilityOutcome = outcome;
    this.hangupScheduled = true;
    this.hangupScheduledAt = Date.now();
    this.clearOpeningGreeting();
    callInfo(`hangup: scheduled outcome=${outcome ?? 'none'}`, this.logger);
    setTimeout(() => void this.playGoodbyeAndHangup(), HANGUP_DEFER_MS);
  }

  waitUntilClosed(): Promise<void> {
    return this.closePromise ?? Promise.resolve();
  }

  private generateOpeningReply(language: LanguageCode): void {
    if (this.openingGreeted || this.hangupStarted) return;
    this.openingGreeted = true;
    this.setSpokenLanguage(language, 'opening');

    const instructions =
      this.openingBuildInstructions?.(language) ??
      `Introduce yourself briefly and ask if the property is still available. Speak in ${language}.`;

    try {
      this.requireSession().generateReply({
        instructions,
        toolChoice: 'none',
        allowInterruptions: !this.isOutboundCall,
      });
    } catch (error) {
      callError(`opening generateReply failed: ${error}`, this.logger);
    }
  }

  private clearOpeningGreeting(): void {
    if (this.openingTimer) {
      clearTimeout(this.openingTimer);
      this.openingTimer = undefined;
    }
    this.openingArmed = false;
  }

  private attachSessionEvents(session: voice.AgentSession): void {
    let agentState: voice.AgentState = 'initializing';
    let turnCommitTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTurnCommitTimer = () => {
      if (turnCommitTimer) {
        clearTimeout(turnCommitTimer);
        turnCommitTimer = undefined;
      }
    };

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      agentState = ev.newState;
      this.agentState = ev.newState;
      if (ev.oldState === 'speaking' && ev.newState !== 'speaking') {
        this.lastAgentSpeechEndedAt = Date.now();
      }
      callInfo(`agent: ${ev.oldState} → ${ev.newState}`, this.logger);
      if (ev.newState === 'thinking' || ev.newState === 'speaking') {
        clearTurnCommitTimer();
        this.clearOpeningGreeting();
      }
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== 'message') return;
      const text = item.textContent?.trim();
      if (!text) return;
      const who =
        item.role === 'user' ? 'owner' : item.role === 'assistant' ? 'agent' : item.role;
      callInfo(`${who}: ${text}`, this.logger);
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      callError('session error', this.logger, { error: ev.error });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.transcript.trim()) {
        this.callRecord?.transcriptBuilder.addUserTranscript(ev.transcript, {
          isFinal: ev.isFinal,
          language: ev.language,
          source: 'stt',
        });
      }

      if (!this.isOutboundCall || !ev.transcript.trim()) return;

      const resolved = this.languageManager.resolveSpokenLanguage(
        ev.transcript,
        ev.language,
      );

      // Only decide language on final turns — log switch vs keep so call status is clear.
      if (ev.isFinal) {
        const current = this.languageManager.getCurrentLanguage();
        const sttHint = ev.language ?? 'null';
        const heard = truncateForLog(ev.transcript);

        if (resolved && resolved !== current) {
          this.setSpokenLanguage(resolved, `stt heard="${heard}" sttHint=${sttHint}`);
        } else if (resolved && resolved === current) {
          callInfo(
            `language: keep ${current} (confirmed, heard="${heard}" sttHint=${sttHint})`,
            this.logger,
          );
        } else {
          callInfo(
            `language: keep ${current} (no switch, heard="${heard}" sttHint=${sttHint})`,
            this.logger,
          );
        }
      }

      if ((this.openingArmed || this.pendingOwnerLanguageGreeting) && !this.openingGreeted) {
        if (this.openingArmed) {
          this.clearOpeningGreeting();
          this.pendingOwnerLanguageGreeting = true;
        }
        if (ev.isFinal) {
          this.pendingOwnerLanguageGreeting = false;
          this.openingGreeted = true;
        }
      }

      if (!ev.isFinal) return;

      clearTurnCommitTimer();
      turnCommitTimer = setTimeout(() => {
        turnCommitTimer = undefined;
        if (agentState !== 'thinking' && agentState !== 'speaking') {
          session.commitUserTurn();
        }
      }, TURN_COMMIT_FALLBACK_MS);
    });
  }

  private createClosePromise(session: voice.AgentSession): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveClose = resolve;
      session.on(voice.AgentSessionEventTypes.Close, (ev) => {
        void this.finalizeHangup(String(ev.reason));
      });
    });
  }

  private async playGoodbyeAndHangup(): Promise<void> {
    if (this.hangupStarted) return;
    this.hangupStarted = true;
    this.clearOpeningGreeting();

    const session = this.requireSession();
    const language = this.languageManager.getCurrentLanguage();
    this.setSpokenLanguage(language, 'goodbye');
    const ttsSpeed = getSettings().ttsSpeed;
    const sipDrainMs = Math.round(
      GOODBYE_SIP_DRAIN_GRACE_MS / Math.min(1, Math.max(0.5, ttsSpeed)),
    );

    let goodbyeTimedOut = false;

    try {
      if (this.availabilityOutcome) {
        const closingAlreadyFinished =
          this.lastAgentSpeechEndedAt >= this.hangupScheduledAt;
        const closingStarted =
          closingAlreadyFinished ||
          this.agentState === 'speaking' ||
          (await this.waitForAgentState('speaking', 15_000));

        if (closingStarted) {
          const closingFinished =
            closingAlreadyFinished ||
            (await this.waitForAgentState('listening', GOODBYE_PLAYOUT_TIMEOUT_MS));
          goodbyeTimedOut = !closingFinished;
        } else {
          callWarn('closing: model never spoke — playing fallback', this.logger);
          try {
            session.interrupt({ force: true });
          } catch {
            /* ignore */
          }
          await sleep(200);
          const fallback = availabilityClosing(this.availabilityOutcome, language);
          this.callRecord?.transcriptBuilder.addAssistantText(fallback, 'closing');
          const speech = session.say(fallback, { allowInterruptions: false });
          goodbyeTimedOut = await raceWithTimeout(
            speech.waitForPlayout(),
            GOODBYE_PLAYOUT_TIMEOUT_MS,
          );
        }
      } else {
        const goodbyeText = goodbyeForLanguage(language);
        this.callRecord?.transcriptBuilder.addAssistantText(goodbyeText, 'closing');
        const speech = session.say(goodbyeText, { allowInterruptions: false });
        goodbyeTimedOut = await raceWithTimeout(
          speech.waitForPlayout(),
          GOODBYE_PLAYOUT_TIMEOUT_MS,
        );
      }

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
    session.shutdown({ drain: false, reason: 'availability confirmed' });
    await this.finalizeHangup('after_shutdown');

    setTimeout(() => {
      if (this.closeResolved && this.roomDeleted) return;
      void this.finalizeHangup('close_fallback_timeout');
    }, CLOSE_FALLBACK_TIMEOUT_MS);
  }

  private waitForAgentState(
    target: voice.AgentState,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.agentState === target) return Promise.resolve(true);

    return new Promise((resolve) => {
      const session = this.session;
      if (!session) {
        resolve(false);
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onStateChanged = (ev: { newState: voice.AgentState }) => {
        if (ev.newState === target) {
          cleanup();
          resolve(true);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        session.off(voice.AgentSessionEventTypes.AgentStateChanged, onStateChanged);
      };

      session.on(voice.AgentSessionEventTypes.AgentStateChanged, onStateChanged);
    });
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
      await this.persistCallLog(report);
    } catch (error) {
      callWarn(`session report failed: ${error}`, this.logger);
    }

    const jobCtx = getJobContext(false) ?? this.ctx;
    jobCtx.shutdown(reason);
    this.resolveClose?.();
  }

  private async persistCallLog(
    report?: ReturnType<JobContext['makeSessionReport']>,
  ): Promise<void> {
    if (this.persistStarted || !this.callRecord) return;
    this.persistStarted = true;

    const snapshot = this.callRecord.finalize(report ?? null);
    await safeCompleteCallLog(snapshot);
    try {
      await saveCallResultSnapshot(snapshot);
    } catch (error) {
      callWarn(`file snapshot failed job=${snapshot.jobId}: ${error}`, this.logger);
    }
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
