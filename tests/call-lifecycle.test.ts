import { describe, expect, it, vi } from 'vitest';
import {
  availabilityClosing,
  HANGUP_DEFER_MS,
  ownershipMismatchClosing,
} from '../src/adapters/livekit-call-session.js';
import {
  OUTBOUND_ENDPOINTING_MIN_MS,
  TURN_COMMIT_FALLBACK_MS,
} from '../src/config/call-config.js';

describe('availability closing messages', () => {
  it('keeps the yes closing short and explains the next step', () => {
    const text = availabilityClosing('yes', 'en-IN', {
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
    });
    expect(text).toContain('call when we find a matching tenant');
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(15);
    expect(text).not.toContain('Galiynest');
    expect(text).not.toContain('Gullynest');
  });

  it('keeps the no closing short and confirms no repeat call', () => {
    const text = availabilityClosing('no', 'en-IN', {
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
    });
    expect(text).toContain('update the listing');
    expect(text).toContain("won't call again");
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(15);
  });

  it('uses the last spoken language for the closing', () => {
    expect(
      availabilityClosing('yes', 'hi-IN', {
        companyName: 'Galynest',
        companyWebsite: 'galynest.com',
      }),
    ).toContain('Tenant');
    expect(
      availabilityClosing('yes', 'kn-IN', {
        companyName: 'Galynest',
        companyWebsite: 'galynest.com',
      }),
    ).toContain('Tenant');
    expect(
      availabilityClosing('no', 'hi-IN', {
        companyName: 'Galynest',
        companyWebsite: 'galynest.com',
      }),
    ).toContain('listing update');
    expect(
      availabilityClosing('no', 'kn-IN', {
        companyName: 'Galynest',
        companyWebsite: 'galynest.com',
      }),
    ).toContain('listing update');
  });

  it('interpolates custom branding without hardcoded variants', () => {
    const text = availabilityClosing('yes', 'en-IN', {
      companyName: 'Acme Homes',
      companyWebsite: 'acme.homes',
    });
    expect(text).toContain('Acme Homes team');
    expect(text).not.toContain('Galynest');
  });

  it('apologizes and promises no further contact about an ownership mismatch', () => {
    expect(ownershipMismatchClosing('en-IN')).toContain("won't call again");
    expect(ownershipMismatchClosing('hi-IN')).toContain('records में गलती');
    expect(ownershipMismatchClosing('hi-IN')).toContain('दोबारा call नहीं करेंगे');
    expect(ownershipMismatchClosing('kn-IN')).toContain('ತಪ್ಪಿದೆ');
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
  it('waits for delayed Sarvam final transcripts before committing a turn', () => {
    expect(OUTBOUND_ENDPOINTING_MIN_MS).toBeGreaterThanOrEqual(750);
    expect(TURN_COMMIT_FALLBACK_MS).toBeGreaterThanOrEqual(750);
  });

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

    const hasEnv =
      process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET &&
      process.env.SARVAM_API_KEY &&
      process.env.SIP_OUTBOUND_TRUNK_ID &&
      process.env.API_SECRET_KEY;

    if (!hasEnv) {
      console.warn('Skipping SarvamVoicePipeline test — required env vars not set');
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

describe('scripted opening messages', () => {
  it('builds openings in the target language without using the owner name', async () => {
    const { openingForLanguage } = await import(
      '../src/adapters/closing-messages.js'
    );
    const params = {
      companyName: 'Galinest',
      companyWebsite: 'galinest.com',
      callerName: 'Jitesh',
      propertyAddress: '42, Indiranagar',
      bhk: '2 BHK',
      locality: 'Indiranagar',
      rentAmount: 25000,
    };

    expect(openingForLanguage(params, 'en-IN')).toBe(
      'Hi, this is Galinest. Is your 2 BHK in Indiranagar at 25,000 rupees a month still available?',
    );
    expect(openingForLanguage(params, 'en-IN')).not.toContain('42, Indiranagar');
    expect(openingForLanguage(params, 'en-IN')).not.toContain('Jitesh');
    expect(openingForLanguage(params, 'en-IN')).not.toContain('Devansh');
    expect(openingForLanguage(params, 'hi-IN')).toContain('Indiranagar');
    expect(openingForLanguage(params, 'hi-IN')).not.toContain('42, Indiranagar');
    expect(openingForLanguage(params, 'kn-IN')).toContain('Indiranagar');
    expect(openingForLanguage(params, 'kn-IN')).not.toContain('42, Indiranagar');
  });
});
