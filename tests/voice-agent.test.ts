import { describe, expect, it } from 'vitest';
import {
  LanguageManager,
  UnsupportedLanguageDebouncer,
} from '../src/core/language-manager.js';
import { createPropertyAvailabilityJob, toDispatchMetadata } from '../src/jobs/models.js';
import { applySpokenLanguage } from '../src/adapters/spoken-language.js';

describe('LanguageManager', () => {
  const manager = new LanguageManager();

  it('detects English affirmative', () => {
    const result = manager.detectFromText('Yes, the property is still available');
    expect(result.language).toBe('en-IN');
    expect(result.isAffirmative).toBe(true);
  });

  it('detects Hindi devanagari', () => {
    const result = manager.detectFromText('हाँ, संपत्ति उपलब्ध है');
    expect(result.language).toBe('hi-IN');
  });

  it('detects Kannada affirmative', () => {
    const result = manager.detectFromText('ಹೌದು, ಈ ಆಸ್ತಿ ಲಭ್ಯವಿದೆ');
    expect(result.language).toBe('kn-IN');
    expect(result.isAffirmative).toBe(true);
  });

  it('detects Kannada negative', () => {
    const result = manager.detectFromText('ಇಲ್ಲ, ಲಭ್ಯವಿಲ್ಲ');
    expect(result.language).toBe('kn-IN');
    expect(result.isNegative).toBe(true);
  });

  it('detects Hindi negative', () => {
    const result = manager.detectFromText('नहीं, उपलब्ध नहीं है');
    expect(result.language).toBe('hi-IN');
    expect(result.isNegative).toBe(true);
  });

  it('detects Romanized Hindi and Kannada', () => {
    expect(new LanguageManager().detectFromText('haan ji meri property').language).toBe(
      'hi-IN',
    );
    expect(new LanguageManager().detectFromText('haudu idu available').language).toBe(
      'kn-IN',
    );
  });

  it('keeps conversation language on short yes/no answers', () => {
    const hiMgr = new LanguageManager('hi-IN');
    expect(hiMgr.resolveSpokenLanguage('yes', 'en-IN')).toBeNull();
    expect(hiMgr.resolveSpokenLanguage('haan', 'hi-IN')).toBeNull();
    expect(hiMgr.getCurrentLanguage()).toBe('hi-IN');

    const enMgr = new LanguageManager('en-IN');
    expect(enMgr.resolveSpokenLanguage('हाँ प्रॉपर्टी उपलब्ध है', 'hi-IN')).toBe(
      'hi-IN',
    );
  });

  it('detects English negative', () => {
    const result = manager.detectFromText('No, it is not available anymore');
    expect(result.language).toBe('en-IN');
    expect(result.isNegative).toBe(true);
  });

  it('does not treat know/another as negative via substring', () => {
    const result = manager.detectFromText(
      'No, but you said Gullynest listed this, then how do I know if it is available?',
    );
    expect(result.isNegative).toBe(true);
    expect(
      LanguageManager.isShortYesNo(
        'No, but you said Gullynest listed this, then how do I know if it is available?',
      ),
    ).toBe(false);
    expect(manager.detectFromText('I want to know more').isNegative).toBeNull();
  });

  it('honors explicit language switch requests', () => {
    expect(
      LanguageManager.detectExplicitLanguageRequest('please speak in English'),
    ).toBe('en-IN');
    expect(
      new LanguageManager('kn-IN').resolveSpokenLanguage(
        'please switch to English',
        'kn-IN',
      ),
    ).toBe('en-IN');
  });

  it('recognizes Gujarati as unsupported instead of passing it to TTS', () => {
    expect(
      LanguageManager.detectUnsupportedLanguage(
        'તમે કોણ બોલો છો મારા નામ?',
        'gu-IN',
      ),
    ).toBe('gu-IN');
    expect(
      LanguageManager.detectUnsupportedLanguage('શું ખબર?', null),
    ).toBe('gu-IN');
    expect(
      LanguageManager.detectUnsupportedLanguage('बॉक्स की लिंक वगैरे.', 'mr-IN'),
    ).toBe('mr-in');
    expect(
      LanguageManager.detectUnsupportedLanguage('ആ അതെ അതെ.', 'ml-IN'),
    ).toBe('ml-in');
  });

  it.each([
    'क्या आप हिंदी में बात कर सकते हो?',
    'आप कौन बोल रहे हो?',
    'તમે કોણ બોલો છો મારા નામ?',
    'શું ખબર?',
    'Who is this speaking?',
    'What is Galynest?',
  ])('does not fast-path question "%s" as yes/no', (text) => {
    expect(LanguageManager.isShortYesNo(text)).toBe(false);
  });

  it('does not fast-path ambiguous politeness fragments', () => {
    expect(LanguageManager.isShortYesNo('ji')).toBe(false);
    expect(LanguageManager.isShortYesNo('okay')).toBe(false);
    expect(LanguageManager.isShortYesNo('ha ji')).toBe(false);
    expect(LanguageManager.isShortYesNo('haan')).toBe(true);
    expect(LanguageManager.isShortYesNo('no')).toBe(true);
  });

  it('fast-paths punctuated Indic yes/no without splitting combining marks', () => {
    expect(LanguageManager.isShortYesNo('नहीं।')).toBe(true);
    expect(LanguageManager.isShortYesNo('हाँ।')).toBe(true);
    expect(LanguageManager.isShortYesNo('ਨਹੀਂ।')).toBe(true);
    expect(
      new LanguageManager('hi-IN').detectFromText('ਨਹੀਂ।').isNegative,
    ).toBe(true);
    expect(
      LanguageManager.detectUnsupportedLanguage('ਨਹੀਂ।', 'pa-IN'),
    ).toBeNull();
  });

  it('requires two consecutive unsupported-language turns', () => {
    const debouncer = new UnsupportedLanguageDebouncer();
    expect(debouncer.observe('mr-in')).toBeNull();
    expect(debouncer.observe(null)).toBeNull();
    expect(debouncer.observe('mr-in')).toBeNull();
    expect(debouncer.observe('mr-in')).toBe('mr-in');
  });

  it('does not flap to Kannada from STT alone on English speech', () => {
    const mgr = new LanguageManager('en-IN');
    expect(
      mgr.resolveSpokenLanguage('how much is the rent for this flat', 'kn-IN'),
    ).toBe('en-IN');
  });

  it('maps TTS speakers', () => {
    expect(manager.getTtsSpeaker('hi-IN')).toBe('anand');
    expect(manager.getTtsSpeaker('kn-IN')).toBe('priya');
    expect(manager.getTtsSpeaker('en-IN')).toBe('aditya');
  });
});

describe('TTS provider language updates', () => {
  it('uses provider-specific update options', () => {
    const updates: Record<string, unknown>[] = [];
    const tts = {
      updateOptions(options: Record<string, unknown>) {
        updates.push(options);
      },
    };

    applySpokenLanguage(tts, 'hi-IN', 'elevenlabs', 'voice-abc');
    applySpokenLanguage(tts, 'kn-IN', 'sarvam');

    expect(updates).toEqual([
      { language: 'hi-IN', voiceId: 'voice-abc' },
      { targetLanguageCode: 'kn-IN', speaker: 'priya' },
    ]);
  });
});

describe('TTS volume gain', () => {
  it('scales PCM samples down without clipping', async () => {
    const { applyTtsVolumeGain } = await import('../src/adapters/tts-volume.js');
    const data = new Int16Array([10000, -10000, 20000]);
    const frame = {
      data,
      sampleRate: 16000,
      channels: 1,
      samplesPerChannel: 3,
    };
    applyTtsVolumeGain(frame as never, 0.5);
    expect([...data]).toEqual([5000, -5000, 10000]);
  });
});

describe('PropertyAvailabilityCallJob', () => {
  it('includes phone in dispatch metadata', () => {
    const job = createPropertyAvailabilityJob({
      owner: { name: 'Ramesh', phoneNumber: '+919876543210' },
      property: {
        propertyId: 'PROP-001',
        address: '42 Indiranagar',
        bhk: '2 BHK',
        rentAmount: 25000,
        city: 'Bangalore',
      },
      callerName: 'Aditi',
      metadata: { tts_provider: 'elevenlabs' },
    });

    const meta = toDispatchMetadata(job);
    expect(meta.phone_number).toBe('+919876543210');
    expect(meta.job_type).toBe('property_availability');
    expect(meta.owner_name).toBe('Ramesh');
    expect(meta.caller_name).toBe('Aditi');
    expect(meta.property_id).toBe('PROP-001');
    expect(meta.rent_amount).toBe(25000);
    expect(meta.tts_provider).toBe('elevenlabs');
  });
});
