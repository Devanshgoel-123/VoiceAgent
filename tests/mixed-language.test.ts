import { describe, expect, it } from 'vitest';
import { availabilityClosing } from '../src/adapters/livekit-call-session.js';
import {
  LanguageManager,
  type LanguageCode,
} from '../src/core/language-manager.js';
import { CallTranscriptBuilder } from '../src/jobs/transcript.js';

interface MixedLanguageScenario {
  name: string;
  utterances: Array<{ text: string; language: LanguageCode }>;
  expectedLastLanguage: LanguageCode;
  expectedClosingText: string;
}

const scenarios: MixedLanguageScenario[] = [
  {
    name: 'English to Hindi',
    utterances: [
      { text: 'Hello, who is this?', language: 'en-IN' },
      { text: 'हाँ, प्रॉपर्टी उपलब्ध है', language: 'hi-IN' },
    ],
    expectedLastLanguage: 'hi-IN',
    expectedClosingText: 'Tenant',
  },
  {
    name: 'Hindi to Kannada',
    utterances: [
      { text: 'नमस्ते', language: 'hi-IN' },
      { text: 'ಹೌದು, ಈ ಆಸ್ತಿ ಲಭ್ಯವಿದೆ', language: 'kn-IN' },
    ],
    expectedLastLanguage: 'kn-IN',
    expectedClosingText: 'Tenant',
  },
  {
    name: 'Kannada to English',
    utterances: [
      { text: 'ನಮಸ್ಕಾರ', language: 'kn-IN' },
      { text: 'Yes, it is available', language: 'en-IN' },
    ],
    expectedLastLanguage: 'en-IN',
    expectedClosingText: 'matching tenant',
  },
  {
    name: 'English to Hindi to Kannada',
    utterances: [
      { text: 'Hello', language: 'en-IN' },
      { text: 'हिंदी में बात कीजिए', language: 'hi-IN' },
      { text: 'ಹೌದು', language: 'kn-IN' },
    ],
    expectedLastLanguage: 'kn-IN',
    expectedClosingText: 'Tenant',
  },
];

describe.each(scenarios)('mixed-language call: $name', (scenario) => {
  it('uses the final spoken language for the closing', () => {
    const manager = new LanguageManager('en-IN');

    for (const utterance of scenario.utterances) {
      const sttLanguage =
        LanguageManager.normalizeLanguageCode(utterance.language);
      manager.detectFromText(utterance.text);
      manager.setLanguage(sttLanguage ?? 'en-IN');
    }

    expect(manager.getCurrentLanguage()).toBe(scenario.expectedLastLanguage);
    expect(
      availabilityClosing('yes', manager.getCurrentLanguage(), {
        companyName: 'Galynest',
        companyWebsite: 'galynest.com',
      }),
    ).toContain(scenario.expectedClosingText);
  });

  it('records every language involved without duplicates', () => {
    const transcript = new CallTranscriptBuilder();

    for (const utterance of scenario.utterances) {
      transcript.addUserTranscript(utterance.text, {
        isFinal: true,
        language: utterance.language,
      });
    }

    expect(transcript.getLanguages()).toEqual([
      ...new Set(scenario.utterances.map(({ language }) => language)),
    ]);
  });
});
