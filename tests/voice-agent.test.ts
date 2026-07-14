import { describe, expect, it } from 'vitest';
import { LanguageManager } from '../src/core/language-manager.js';
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
    expect(manager.detectFromText('haan ji').language).toBe('hi-IN');
    expect(manager.detectFromText('haudu').language).toBe('kn-IN');
  });

  it('detects English negative', () => {
    const result = manager.detectFromText('No, it is not available anymore');
    expect(result.language).toBe('en-IN');
    expect(result.isNegative).toBe(true);
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

    applySpokenLanguage(tts, 'hi-IN', 'elevenlabs');
    applySpokenLanguage(tts, 'kn-IN', 'sarvam');

    expect(updates).toEqual([
      { language: 'hi-IN' },
      { targetLanguageCode: 'kn-IN', speaker: 'priya' },
    ]);
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
      metadata: { tts_provider: 'elevenlabs' },
    });

    const meta = toDispatchMetadata(job);
    expect(meta.phone_number).toBe('+919876543210');
    expect(meta.job_type).toBe('property_availability');
    expect(meta.owner_name).toBe('Ramesh');
    expect(meta.property_id).toBe('PROP-001');
    expect(meta.rent_amount).toBe(25000);
    expect(meta.tts_provider).toBe('elevenlabs');
  });
});
