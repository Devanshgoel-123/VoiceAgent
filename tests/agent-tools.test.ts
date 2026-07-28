import { describe, expect, it, vi } from 'vitest';
import type { CallLifecycle } from '../src/adapters/livekit-call-session.js';
import {
  buildPropertyTools,
  isClearAvailabilityResponse,
} from '../src/agents/property-availability/agent.js';
import type { CallMetadata } from '../src/core/types.js';
import { isOwnershipMismatch } from '../src/core/owner-intent.js';

describe('recordPropertyAvailability tool behavior', () => {
  it('records yes and schedules hangup once', async () => {
    const lifecycle: CallLifecycle = {
      scheduleHangup: vi.fn(),
      setSpokenLanguage: vi.fn(),
      getCurrentLanguage: vi.fn(() => 'en-IN'),
      getLastOwnerTranscript: vi.fn(() => 'Yes it is available'),
      recordOwnerOutcome: vi.fn(),
      recordDoNotCall: vi.fn(),
    };

    const metadata: CallMetadata = {
      job_id: 'job-tool-test',
      property_address: '42 Indiranagar',
      company_name: 'Galynest',
      company_website: 'galynest.com',
      caller_name: 'Aditi',
    };

    const state = {
      jobId: 'job-tool-test',
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
      callMetadata: metadata,
      propertyAvailable: 'not_asked' as const,
      outcomeRecorded: false,
      doNotCallRecorded: false,
    };

    const tools = buildPropertyTools(state, lifecycle);
    const result = await tools.recordPropertyAvailability.execute({
      isAvailable: true,
      ownerResponse: 'Yes it is available',
    });

    expect(result).toContain('Do not speak');
    expect(lifecycle.recordOwnerOutcome).toHaveBeenCalledWith(
      'yes',
      expect.stringContaining('Yes it is available'),
    );
    expect(lifecycle.scheduleHangup).toHaveBeenCalledWith('yes');
    expect(state.propertyAvailable).toBe('yes');
  });

  it('records explicit opt-out and schedules hangup', async () => {
    const lifecycle: CallLifecycle = {
      scheduleHangup: vi.fn(),
      setSpokenLanguage: vi.fn(),
      getCurrentLanguage: vi.fn(() => 'en-IN'),
      getLastOwnerTranscript: vi.fn(() => 'Please do not call me again'),
      recordOwnerOutcome: vi.fn(),
      recordDoNotCall: vi.fn(),
    };

    const state = {
      jobId: 'job-tool-test',
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
      callMetadata: {} as CallMetadata,
      propertyAvailable: 'not_asked' as const,
      outcomeRecorded: false,
      doNotCallRecorded: false,
    };

    const tools = buildPropertyTools(state, lifecycle);
    const result = await tools.recordDoNotCall.execute({
      ownerRequest: 'Please do not call me again',
    });

    expect(result).toContain('Opt-out recorded');
    expect(lifecycle.recordDoNotCall).toHaveBeenCalledWith(
      'Please do not call me again',
    );
    expect(lifecycle.scheduleHangup).toHaveBeenCalledWith('no');
    expect(state.doNotCallRecorded).toBe(true);
  });

  it.each([
    'Who is this speaking?',
    'What is Galynest?',
    'क्या आप हिंदी में बात कर सकते हो?',
    'आप कौन बोल रहे हो?',
    'તમે કોણ બોલો છો મારા નામ?',
    'I don’t know about this property, please hang up.',
  ])('does not treat "%s" as a clear availability answer', (text) => {
    expect(isClearAvailabilityResponse(text)).toBe(false);
  });

  it('rejects an ambiguous availability tool call without hanging up', async () => {
    const lifecycle: CallLifecycle = {
      scheduleHangup: vi.fn(),
      setSpokenLanguage: vi.fn(),
      getCurrentLanguage: vi.fn(() => 'en-IN'),
      getLastOwnerTranscript: vi.fn(
        () => 'I do not know about this property, please hang up.',
      ),
      recordOwnerOutcome: vi.fn(),
      recordDoNotCall: vi.fn(),
    };
    const state = {
      jobId: 'job-tool-test',
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
      callMetadata: {} as CallMetadata,
      propertyAvailable: 'not_asked' as const,
      outcomeRecorded: false,
      doNotCallRecorded: false,
    };

    const tools = buildPropertyTools(state, lifecycle);
    const result = await tools.recordPropertyAvailability.execute({
      isAvailable: false,
      ownerResponse: 'I do not know about this property, please hang up.',
    });

    expect(result).toContain('Not recorded');
    expect(lifecycle.recordOwnerOutcome).not.toHaveBeenCalled();
    expect(lifecycle.scheduleHangup).not.toHaveBeenCalled();
    expect(state.propertyAvailable).toBe('not_asked');
  });

  it('detects ownership mismatch in Hindi before asking availability again', () => {
    expect(isOwnershipMismatch('जी ये प्रॉपर्टी मेरी नहीं है।')).toBe(true);
    expect(
      isOwnershipMismatch('नहीं उपलब्ध नहीं है क्योंकि यह प्रॉपर्टी मेरी नहीं है।'),
    ).toBe(true);
    expect(isClearAvailabilityResponse('जी ये प्रॉपर्टी मेरी नहीं है।')).toBe(false);
  });

  it('does not mistake क्योंकि for the question word क्यों', () => {
    expect(
      isClearAvailabilityResponse(
        'नहीं, उपलब्ध नहीं है क्योंकि यह किराये पर चली गई है।',
      ),
    ).toBe(true);
  });

  it('validates the real STT transcript instead of fabricated tool text', async () => {
    const lifecycle: CallLifecycle = {
      scheduleHangup: vi.fn(),
      setSpokenLanguage: vi.fn(),
      getCurrentLanguage: vi.fn(() => 'hi-IN'),
      getLastOwnerTranscript: vi.fn(() => 'Okay'),
      recordOwnerOutcome: vi.fn(),
      recordDoNotCall: vi.fn(),
    };
    const state = {
      jobId: 'job-tool-test',
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
      callMetadata: {} as CallMetadata,
      propertyAvailable: 'not_asked' as const,
      outcomeRecorded: false,
      doNotCallRecorded: false,
    };

    const tools = buildPropertyTools(state, lifecycle);
    const result = await tools.recordPropertyAvailability.execute({
      isAvailable: true,
      ownerResponse: 'Yes, the property is still available for rent.',
    });

    expect(result).toContain('Not recorded');
    expect(lifecycle.scheduleHangup).not.toHaveBeenCalled();
  });
});
