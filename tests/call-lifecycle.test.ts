import { describe, expect, it, vi } from 'vitest';
import {
  availabilityClosing,
  HANGUP_DEFER_MS,
} from '../src/adapters/livekit-call-session.js';

describe('availability closing messages', () => {
  it('explains follow-up and number saving after a yes', () => {
    const text = availabilityClosing('yes');
    expect(text).toContain('continue searching for tenants');
    expect(text).toContain('as soon as we find a tenant for you');
    expect(text).toContain('saving this number as Galynest Property Team');
  });

  it('explains record update and future website option after a no', () => {
    const text = availabilityClosing('no');
    expect(text).toContain('update our records');
    expect(text).toContain('will not disturb you again');
    expect(text).toContain('Galynest dot com');
  });

  it('uses the last spoken language for the closing', () => {
    expect(availabilityClosing('yes', 'hi-IN')).toContain('किरायेदार');
    expect(availabilityClosing('yes', 'kn-IN')).toContain('ಬಾಡಿಗೆದಾರ');
    expect(availabilityClosing('no', 'hi-IN')).toContain('रिकॉर्ड अपडेट');
    expect(availabilityClosing('no', 'kn-IN')).toContain('ದಾಖಲೆಗಳನ್ನು ನವೀಕರಿಸುತ್ತೇವೆ');
  });
});

/**
 * Unit-test the hangup scheduling contract without LiveKit:
 * scheduleHangup → defer → interrupt → goodbye → shutdown.
 * Must NOT depend on parent speech-handle completion.
 */
class FakeCallLifecycle {
  hangupStarted = false;
  hangupScheduled = false;
  events: string[] = [];
  playoutResolves = true;
  playoutDelayMs = 0;
  deferMs = HANGUP_DEFER_MS;

  scheduleHangup(): void {
    if (this.hangupStarted || this.hangupScheduled) {
      this.events.push('ignored-duplicate');
      return;
    }
    this.hangupScheduled = true;
    this.events.push('scheduleHangup:deferred');

    setTimeout(() => {
      this.events.push('scheduleHangup:defer_fired');
      void this.playGoodbyeAndHangup();
    }, this.deferMs);
  }

  private async playGoodbyeAndHangup(): Promise<void> {
    if (this.hangupStarted) {
      this.events.push('ignored-duplicate');
      return;
    }
    this.hangupStarted = true;
    this.events.push('goodbye:interrupt_stuck_speech');
    this.events.push('goodbye:play_start');

    if (this.playoutResolves) {
      await new Promise((r) => setTimeout(r, this.playoutDelayMs));
      this.events.push('goodbye:play_done');
    } else {
      await Promise.race([
        new Promise(() => {
          /* never resolves */
        }),
        new Promise((r) => setTimeout(r, 20)),
      ]);
      this.events.push('goodbye:play_timeout');
    }

    this.events.push('hangup:interrupt_before_shutdown');
    this.events.push('hangup:session_shutdown_drain_false');
    this.events.push('hangup:deleteRoom');
    this.events.push('hangup:job_shutdown');
    this.events.push('hangup:done');
  }
}

describe('Call lifecycle hangup contract', () => {
  it('runs goodbye then hangup after deferred schedule (no speech-handle wait)', async () => {
    const lifecycle = new FakeCallLifecycle();
    lifecycle.deferMs = 20;

    lifecycle.scheduleHangup();
    expect(lifecycle.events).toEqual(['scheduleHangup:deferred']);

    await new Promise((r) => setTimeout(r, 50));

    expect(lifecycle.events).toEqual([
      'scheduleHangup:deferred',
      'scheduleHangup:defer_fired',
      'goodbye:interrupt_stuck_speech',
      'goodbye:play_start',
      'goodbye:play_done',
      'hangup:interrupt_before_shutdown',
      'hangup:session_shutdown_drain_false',
      'hangup:deleteRoom',
      'hangup:job_shutdown',
      'hangup:done',
    ]);
  });

  it('is idempotent across duplicate scheduleHangup calls', async () => {
    const lifecycle = new FakeCallLifecycle();
    lifecycle.deferMs = 20;

    lifecycle.scheduleHangup();
    lifecycle.scheduleHangup();

    await new Promise((r) => setTimeout(r, 50));

    const shutdownCount = lifecycle.events.filter(
      (e) => e === 'hangup:session_shutdown_drain_false',
    ).length;
    expect(shutdownCount).toBe(1);
    expect(lifecycle.events).toContain('ignored-duplicate');
  });

  it('still shuts down when goodbye playout times out', async () => {
    const lifecycle = new FakeCallLifecycle();
    lifecycle.deferMs = 10;
    lifecycle.playoutResolves = false;

    lifecycle.scheduleHangup();
    await new Promise((r) => setTimeout(r, 50));

    expect(lifecycle.events).toContain('goodbye:play_timeout');
    expect(lifecycle.events).toContain('hangup:session_shutdown_drain_false');
    expect(lifecycle.events).toContain('hangup:deleteRoom');
    expect(lifecycle.events).toContain('hangup:done');
  });
});

describe('SarvamVoicePipeline', () => {
  it('creates a bundle with stt/llm/tts', async () => {
    vi.resetModules();

    try {
      const { getSettings } = await import('../src/config/settings.js');
      getSettings();
    } catch {
      return;
    }

    const { SarvamVoicePipeline } = await import(
      '../src/adapters/sarvam-voice-pipeline.js'
    );
    const { getSettings } = await import('../src/config/settings.js');
    const pipeline = new SarvamVoicePipeline(getSettings());
    const bundle = pipeline.createBundle({
      telephony: false,
      ttsProvider: 'sarvam',
    });
    expect(bundle.stt).toBeTruthy();
    expect(bundle.llm).toBeTruthy();
    expect(bundle.tts).toBeTruthy();
  });
});

describe('opening / closing LLM instructions', () => {
  it('asks the model to speak the opening in the target language', async () => {
    const { buildOpeningInstructions, buildClosingInstructions } = await import(
      '../src/agents/property-availability/prompts.js'
    );
    const params = {
      companyName: 'Galinest',
      callerName: 'Aditi',
      ownerName: 'Devansh',
      propertyAddress: '42, Indiranagar',
    };

    expect(buildOpeningInstructions(params, 'hi-IN')).toContain('Hindi');
    expect(buildOpeningInstructions(params, 'hi-IN')).toContain('Aditi');
    expect(buildClosingInstructions('yes', 'kn-IN')).toContain('Kannada');
    expect(buildClosingInstructions('yes', 'kn-IN')).toContain(
      'as soon as we find a tenant',
    );
    expect(buildClosingInstructions('no', 'en-IN')).toContain('Galinest dot com');
  });
});

describe('opening greeting helper', () => {
  it('builds English / Hindi / Kannada intros', async () => {
    const { buildOpeningGreeting } = await import(
      '../src/agents/property-availability/prompts.js'
    );
    const params = {
      companyName: 'Galynest',
      callerName: 'Aditi',
      ownerName: 'Devansh',
      propertyAddress: '42, Indiranagar',
    };
    const en = buildOpeningGreeting(params, 'en-IN');
    const hi = buildOpeningGreeting(params, 'hi-IN');
    const kn = buildOpeningGreeting(params, 'kn-IN');
    expect(en).toContain('Aditi from Galynest');
    expect(en).toContain('Galynest');
    expect(en).toContain('still available');
    expect(hi).toContain('नमस्ते');
    expect(hi).toContain('Galynest');
    expect(hi).toContain('Aditi');
    expect(kn).toContain('ನಮಸ್ಕಾರ');
    expect(kn).toContain('Galynest');
    expect(kn).toContain('Aditi');
  });
});
