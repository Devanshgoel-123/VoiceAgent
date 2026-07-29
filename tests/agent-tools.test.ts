import { describe, expect, it, vi } from 'vitest';
import { llm } from '@livekit/agents';
import type { CallLifecycle } from '../src/adapters/livekit-call-session.js';
import {
  buildInferenceLanguageInstruction,
  buildPropertyTools,
  classifyClearAvailabilityResponse,
  commitOwnerTurnTranscript,
  isCountableUnclearAvailabilityResponse,
  isClearAvailabilityResponse,
  withInferenceLanguageInstruction,
} from '../src/agents/property-availability/agent.js';
import type { CallMetadata } from '../src/core/types.js';
import { isOwnershipMismatch } from '../src/core/owner-intent.js';
import type { YesNoAnswer } from '../src/jobs/models.js';

describe('per-inference language instruction', () => {
  it.each([
    ['en-IN', 'English'],
    ['hi-IN', 'Hindi'],
    ['kn-IN', 'Kannada'],
  ] as const)('pins %s immediately before inference', (code, name) => {
    const instruction = buildInferenceLanguageInstruction(code);
    expect(instruction).toContain(`CURRENT RESPONSE LANGUAGE: ${name}`);
    expect(instruction).toContain('overrides earlier conversation language');
  });

  it('uses Sarvam-compatible system role without mutating stored chat history', () => {
    const original = llm.ChatContext.empty();
    original.addMessage({ role: 'user', content: 'What is the address?' });

    const inference = withInferenceLanguageInstruction(original, 'en-IN');

    expect(original.items).toHaveLength(1);
    expect(inference.items).toHaveLength(2);
    expect(inference.items[1]).toMatchObject({
      type: 'message',
      role: 'system',
    });
  });
});

describe('committed owner transcript', () => {
  it('stores the full assembled turn for later tool validation', () => {
    let committed: string | undefined;
    const lifecycle = {
      setCommittedOwnerTranscript(transcript: string) {
        committed = transcript;
      },
    } as Pick<CallLifecycle, 'setCommittedOwnerTranscript'> as CallLifecycle;

    const fullTurn =
      'Okay, but I have multiple BHKs. I want to understand. Can you tell me the address?';
    commitOwnerTurnTranscript(lifecycle, fullTurn);

    expect(committed).toBe(fullTurn);
  });

  it('stores the sanitized full turn instead of an unsupported STT prefix', () => {
    let committed: string | undefined;
    const lifecycle = {
      setCommittedOwnerTranscript(transcript: string) {
        committed = transcript;
      },
    } as Pick<CallLifecycle, 'setCommittedOwnerTranscript'> as CallLifecycle;

    const sanitized = commitOwnerTurnTranscript(
      lifecycle,
      'ആ. Which property is this?',
    );

    expect(sanitized).toBe('Which property is this?');
    expect(committed).toBe('Which property is this?');
  });
});

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

  it.each([
    ['English', 'Yes.'],
    ['English', 'Yes, it is.'],
    ['English', 'Yeah, it is still available.'],
    ['English', 'Correct, the property is available.'],
    ['Hindi', 'हाँ।'],
    ['Hindi', 'जी हाँ।'],
    ['Hindi', 'हाँ, है।'],
    ['Hindi', 'बिल्कुल।'],
    ['Hindi', 'जी हाँ, अवेलेबल है।'],
    ['Hindi (Romanized)', 'haan, available hai'],
    ['Kannada', 'ಹೌದು.'],
    ['Kannada', 'ಹೌದ್ರಿ.'],
    ['Kannada', 'ಹೌದು ಇದೆ.'],
    ['Kannada (mixed)', 'ಹೌದು, available ಇದೆ.'],
  ])('accepts a clear affirmative in %s: "%s"', (_language, text) => {
    expect(isClearAvailabilityResponse(text)).toBe(true);
  });

  it.each([
    ['English', 'No.'],
    ['English', 'No, it is not available.'],
    ['English', 'The property is not available.'],
    ['English', 'It is no longer available.'],
    ['English', 'Nope, it has been rented.'],
    ['Hindi', 'नहीं।'],
    ['Hindi', 'जी नहीं।'],
    ['Hindi', 'नहीं है।'],
    ['Hindi', 'Property available नहीं है।'],
    ['Hindi', 'Property अवेलेबल नहीं है।'],
    ['Hindi', 'नहीं, किराए पर चली गई है।'],
    ['Hindi (Romanized)', 'nahi, rented out hai'],
    ['Kannada', 'ಇಲ್ಲ.'],
    ['Kannada', 'Property available ಇಲ್ಲ.'],
    ['Kannada', 'Property ಲಭ್ಯವಿಲ್ಲ.'],
    ['Kannada', 'ಇಲ್ಲ, rent ಆಗಿದೆ.'],
    ['Kannada', 'ಇಲ್ಲ, available ಇಲ್ಲ.'],
  ])('accepts a clear negative in %s: "%s"', (_language, text) => {
    expect(isClearAvailabilityResponse(text)).toBe(true);
  });

  it.each([
    ['English', 'Okay.'],
    ['English', 'Sure.'],
    ['English', 'Maybe it is available.'],
    ['English', 'Probably available.'],
    ['English', "I don't know if it is available."],
    ['Hindi', 'जी।'],
    ['Hindi', 'ठीक है।'],
    ['Hindi', 'शायद available है।'],
    ['Hindi', 'पता नहीं available है या नहीं।'],
    ['Kannada', 'ಸರಿ.'],
    ['Kannada', 'ಬಹುಶಃ available ಇದೆ.'],
    ['Kannada', 'ಗೊತ್ತಿಲ್ಲ, available ಇದೆಯೋ ಇಲ್ಲವೋ.'],
  ])('rejects an uncertain/polite response in %s: "%s"', (_language, text) => {
    expect(isClearAvailabilityResponse(text)).toBe(false);
  });

  it.each([
    ['English', 'Yes, it is available, but which property'],
    ['English', 'No, but who is calling'],
    ['Hindi', 'हाँ available है लेकिन कौन सी property'],
    ['Hindi', 'नहीं, लेकिन आप कौन बोल रहे हैं'],
    ['Kannada', 'ಹೌದು available ಇದೆ ಆದರೆ ಯಾವ property'],
    ['Kannada', 'ಇಲ್ಲ, ಆದರೆ ಯಾರು call ಮಾಡುತ್ತಿದ್ದೀರಿ'],
  ])('rejects a question containing availability in %s: "%s"', (_language, text) => {
    expect(isClearAvailabilityResponse(text)).toBe(false);
  });

  it.each([
    ['English', 'Yes, but this property is not mine.'],
    ['English', 'No, I am not the owner.'],
    ['Hindi', 'हाँ, लेकिन ये property मेरी नहीं है।'],
    ['Hindi', 'नहीं, मैं मालिक नहीं हूँ।'],
    ['Kannada', 'ಹೌದು, ಈ property ನನ್ನದಲ್ಲ.'],
    ['Kannada', 'ಇಲ್ಲ, ನಾನು ಮಾಲೀಕನಲ್ಲ.'],
  ])('rejects ownership mismatch in %s: "%s"', (_language, text) => {
    expect(isClearAvailabilityResponse(text)).toBe(false);
  });

  it.each([
    ['yes', 'Yes, it is available.'],
    ['no', 'No, it has been rented.'],
    ['no', 'The property is not available.'],
    ['yes', 'जी हाँ, अवेलेबल है।'],
    ['no', 'जी नहीं, available नहीं है।'],
    ['no', 'Property अवेलेबल नहीं है।'],
    ['yes', 'ಹೌದು, available ಇದೆ.'],
    ['no', 'ಇಲ್ಲ, rent ಆಗಿದೆ.'],
    ['no', 'Property available ಇಲ್ಲ.'],
    [null, 'जी हाँ नहीं।'],
    [null, 'Yes and no.'],
  ] as const)('classifies %s polarity from the transcript "%s"', (expected, text) => {
    expect(classifyClearAvailabilityResponse(text)).toBe(expected);
  });

  it('uses transcript polarity when the model passes the opposite boolean', async () => {
    const lifecycle: CallLifecycle = {
      scheduleHangup: vi.fn(),
      setSpokenLanguage: vi.fn(),
      getCurrentLanguage: vi.fn(() => 'hi-IN'),
      getLastOwnerTranscript: vi.fn(() => 'जी नहीं, available नहीं है।'),
      recordOwnerOutcome: vi.fn(),
      recordDoNotCall: vi.fn(),
    };
    const state = {
      jobId: 'job-polarity-test',
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
      callMetadata: {} as CallMetadata,
      propertyAvailable: 'not_asked' as YesNoAnswer,
      outcomeRecorded: false,
      doNotCallRecorded: false,
    };

    const tools = buildPropertyTools(state, lifecycle);
    await tools.recordPropertyAvailability.execute({
      isAvailable: true,
      ownerResponse: 'Yes, available.',
    });

    expect(lifecycle.recordOwnerOutcome).toHaveBeenCalledWith(
      'no',
      expect.stringContaining('जी नहीं'),
    );
    expect(lifecycle.scheduleHangup).toHaveBeenCalledWith('no');
    expect(state.propertyAvailable).toBe('no');
  });

  it('asks once after uncertainty, then records manual intervention and hangs up', async () => {
    let ownerResponse = "I don't know.";
    let committedTurn = 1;
    const lifecycle: CallLifecycle = {
      scheduleHangup: vi.fn(),
      setSpokenLanguage: vi.fn(),
      getCurrentLanguage: vi.fn(() => 'en-IN'),
      getLastOwnerTranscript: vi.fn(() => ownerResponse),
      getCommittedOwnerTurnSequence: vi.fn(() => committedTurn),
      recordOwnerOutcome: vi.fn(),
      recordDoNotCall: vi.fn(),
    };
    const state = {
      jobId: 'job-unclear-test',
      companyName: 'Galynest',
      companyWebsite: 'galynest.com',
      callMetadata: {} as CallMetadata,
      propertyAvailable: 'not_asked' as YesNoAnswer,
      outcomeRecorded: false,
      doNotCallRecorded: false,
      unclearAttemptCount: 0,
    };
    const tools = buildPropertyTools(state, lifecycle);

    const first = await tools.recordPropertyAvailability.execute({
      isAvailable: false,
      ownerResponse,
    });
    expect(first).toContain('first availability response was unclear');
    expect(lifecycle.scheduleHangup).not.toHaveBeenCalled();

    // A model retry within the same owner turn must not consume attempt two.
    await tools.recordPropertyAvailability.execute({
      isAvailable: false,
      ownerResponse,
    });
    expect(state.unclearAttemptCount).toBe(1);
    expect(lifecycle.scheduleHangup).not.toHaveBeenCalled();

    ownerResponse = 'Maybe, I am not sure.';
    committedTurn = 2;
    const second = await tools.recordPropertyAvailability.execute({
      isAvailable: true,
      ownerResponse,
    });

    expect(second).toContain('Manual intervention needed');
    expect(lifecycle.recordOwnerOutcome).toHaveBeenCalledWith(
      'unclear',
      expect.stringContaining('Manual intervention needed'),
    );
    expect(lifecycle.scheduleHangup).toHaveBeenCalledWith();
    expect(state.propertyAvailable).toBe('unclear');
  });

  it.each([
    ["I don't know.", true],
    ['Maybe.', true],
    ['Okay.', true],
    ['Which property?', false],
    ['Can you tell me the address?', false],
    ['Please hang up.', false],
    ['This property is not mine.', false],
  ])('classifies whether unclear response "%s" consumes an attempt', (text, expected) => {
    expect(isCountableUnclearAvailabilityResponse(text)).toBe(expected);
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

  it('treats जी as politeness in a clear Hindi negative answer', () => {
    expect(isClearAvailabilityResponse('जी नहीं, ये उपलब्ध नहीं है।')).toBe(true);
  });

  it('accepts common Hinglish availability words transcribed in Indic script', () => {
    expect(isClearAvailabilityResponse('जी हाँ, अवेलेबल है।')).toBe(true);
    expect(isClearAvailabilityResponse('हाँ, एवेलेबल है।')).toBe(true);
    expect(isClearAvailabilityResponse('ಹೌದು, ಅವೈಲೇಬಲ್ ಇದೆ.')).toBe(true);
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
