import { getJobContext, type JobContext, log, voice } from '@livekit/agents';
import { callDebug, callError, callWarn } from '../core/call-logger.js';
import type { VoicePipelineBundle } from './voice-pipeline.js';

export const DEFAULT_GOODBYE_TEXT = 'Thank you for confirming. Have a great day!';
export const GOODBYE_PLAYOUT_TIMEOUT_MS = 4000;
/** Leave the tool stack, then interrupt any stuck post-tool TTS and hang up. */
export const HANGUP_DEFER_MS = 300;
/** If session Close never fires after shutdown, delete the room anyway. */
export const CLOSE_FALLBACK_TIMEOUT_MS = 1500;

export type CallMetadata = Record<string, unknown>;

export interface CallLifecycle {
  /**
   * After availability is recorded: thank the owner, shut down the session, hang up.
   * Idempotent. Does NOT wait for the parent tool speech handle — that handle often
   * never completes when post-tool TTS hangs in "speaking".
   */
  scheduleHangup(): void;
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

  constructor(options: LiveKitCallSessionOptions) {
    this.ctx = options.jobContext;
    this.logger = options.logger ?? log().child({ room: options.jobContext.room.name });
    this.goodbyeText = options.goodbyeText ?? DEFAULT_GOODBYE_TEXT;
    this.isOutboundCall = options.isOutboundCall;
    this.participantIdentity = options.participantIdentity;
    this.pipeline = options.pipeline;
    callDebug(`[CALL] session.ctor outbound=${this.isOutboundCall} identity=${this.participantIdentity ?? 'none'}`, this.logger);
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
        endpointing: { minDelay: this.isOutboundCall ? 600 : 70 },
        preemptiveGeneration: { enabled: !this.isOutboundCall },
        interruption: {
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
      }
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      callDebug(`[CALL] session.speech_created id=${ev.speechHandle.id} source=${ev.source}`, this.logger);
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      callError('[CALL] session.error', this.logger, { error: ev.error });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!this.isOutboundCall || !ev.isFinal || !ev.transcript.trim()) {
        return;
      }

      callDebug(`[CALL] session.stt:final transcript="${ev.transcript}"`, this.logger);
      clearTurnCommitTimer();
      turnCommitTimer = setTimeout(() => {
        turnCommitTimer = undefined;
        if (canCommitUserTurn()) {
          callDebug('[CALL] session.turn:commit', this.logger);
          session.commitUserTurn();
        } else {
          callDebug(`[CALL] session.turn:commit_skipped state=${agentState}`, this.logger);
        }
      }, 900);
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

    const session = this.requireSession();

    try {
      callDebug('[CALL] session.goodbye:interrupt_stuck_speech', this.logger);
      session.interrupt({ force: true });
    } catch (error) {
      callWarn(`[CALL] session.goodbye:interrupt_fail error=${error}`, this.logger);
    }

    // Let the force-interrupt settle before starting goodbye TTS.
    await sleep(150);

    try {
      callDebug(`[CALL] session.goodbye:play_start text="${this.goodbyeText}"`, this.logger);
      // allowInterruptions so we can force-cut if playout hangs before shutdown
      const speech = session.say(this.goodbyeText, { allowInterruptions: true });
      const timedOut = await raceWithTimeout(
        speech.waitForPlayout(),
        GOODBYE_PLAYOUT_TIMEOUT_MS,
      );
      if (timedOut) {
        callWarn('[CALL] session.goodbye:play_timeout', this.logger);
      } else {
        callDebug('[CALL] session.goodbye:play_done', this.logger);
      }
    } catch (error) {
      callError(`[CALL] session.goodbye:play_fail error=${error}`, this.logger);
    }

    try {
      callDebug('[CALL] session.goodbye:interrupt_before_shutdown', this.logger);
      session.interrupt({ force: true });
    } catch (error) {
      callWarn(`[CALL] session.goodbye:interrupt_before_shutdown_fail error=${error}`, this.logger);
    }

    await sleep(50);

    // drain:false → force-interrupt path; avoids waiting forever on hung TTS playout.
    callDebug('[CALL] session.goodbye:shutdown_start drain=false', this.logger);
    session.shutdown({ drain: false, reason: 'availability confirmed' });
    callDebug('[CALL] session.goodbye:shutdown_requested', this.logger);

    // Do not wait for Close — with outbound closeOnDisconnect:false, SIP stays up
    // until the room is deleted. Delete immediately after shutdown.
    await this.finalizeHangup('after_shutdown');

    // Safety net if finalize somehow raced / Close path still needed elsewhere.
    setTimeout(() => {
      if (this.closeResolved && this.roomDeleted) return;
      callWarn(`[CALL] session.close:fallback_timeout ms=${CLOSE_FALLBACK_TIMEOUT_MS}`, this.logger);
      void this.finalizeHangup('close_fallback_timeout');
    }, CLOSE_FALLBACK_TIMEOUT_MS);
  }

  /** Delete room + shut down job. Idempotent hard hangup. */
  private async finalizeHangup(reason: string): Promise<void> {
    if (this.closeResolved) {
      callDebug(`[CALL] session.finalizeHangup:skip already_done reason=${reason}`, this.logger);
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
        callError(`[CALL] session.finalizeHangup:deleteRoom_fail error=${error}`, this.logger);
      }
    }

    try {
      const session = this.session;
      if (session) {
        const report = this.ctx.makeSessionReport(session);
        if (report.audioRecordingPath) {
          callDebug(`[CALL] session.finalizeHangup:recording path=${report.audioRecordingPath}`, this.logger);
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
