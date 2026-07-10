export type LanguageCode = 'en-IN' | 'hi-IN' | 'kn-IN' | 'unknown';

export interface LanguageDetectionResult {
  language: LanguageCode;
  confidence: number;
  isAffirmative: boolean | null;
  isNegative: boolean | null;
}

const STRONG_AFFIRMATIVE: Record<string, Set<string>> = {
  'en-IN': new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'ok', 'okay']),
  'hi-IN': new Set(['haan', 'han', 'ha', 'ji', 'bilkul', 'haa', 'हाँ', 'हां', 'जी']),
  'kn-IN': new Set(['haudu', 'houdu', 'howdu', 'ಹೌದು', 'ಹೌದ್ರಿ', 'ಸರಿ']),
};

const STRONG_NEGATIVE: Record<string, Set<string>> = {
  'en-IN': new Set(['no', 'nope', 'nah', 'negative']),
  'hi-IN': new Set(['nahi', 'nahin', 'na', 'mat', 'nhi', 'नहीं', 'ना']),
  'kn-IN': new Set(['illa', 'alla', 'beda', 'ಇಲ್ಲ', 'ಬೇಡ']),
};

const WEAK_AFFIRMATIVE: Record<string, Set<string>> = {
  'en-IN': new Set(['available']),
  'hi-IN': new Set(),
  'kn-IN': new Set(),
};

const WEAK_NEGATIVE: Record<string, Set<string>> = {
  'en-IN': new Set(['unavailable', 'not']),
  'hi-IN': new Set(),
  'kn-IN': new Set(),
};

const DEVANAGARI_RE = /[\u0900-\u097F]/g;
const KANNADA_RE = /[\u0C80-\u0CFF]/g;
const LATIN_RE = /[a-zA-Z]/g;

const TTS_SPEAKERS: Record<string, string> = {
  'en-IN': 'aditya',
  'hi-IN': 'anand',
  'kn-IN': 'priya',
};

export class LanguageManager {
  static readonly SUPPORTED: LanguageCode[] = ['en-IN', 'hi-IN', 'kn-IN'];

  private currentLanguage: LanguageCode;

  constructor(defaultLanguage: LanguageCode = 'en-IN') {
    this.currentLanguage = defaultLanguage;
  }

  getCurrentLanguage(): LanguageCode {
    return this.currentLanguage;
  }

  detectFromText(text: string): LanguageDetectionResult {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return {
        language: this.currentLanguage,
        confidence: 0,
        isAffirmative: null,
        isNegative: null,
      };
    }

    const language = this.detectLanguage(normalized);
    const { affirmative, negative } = this.resolveIntent(normalized);

    if (language !== 'unknown') {
      this.currentLanguage = language;
    }

    return {
      language: language !== 'unknown' ? language : this.currentLanguage,
      confidence: language !== 'unknown' ? 0.85 : 0.5,
      isAffirmative: affirmative,
      isNegative: negative,
    };
  }

  getTtsSpeaker(language?: LanguageCode): string {
    const lang = language ?? this.currentLanguage;
    return TTS_SPEAKERS[lang] ?? TTS_SPEAKERS['en-IN'];
  }

  setLanguage(language: LanguageCode): void {
    if ((LanguageManager.SUPPORTED as string[]).includes(language)) {
      this.currentLanguage = language;
    }
  }

  static multilingualInstructions(): string {
    return `
Language rules (critical):
- Listen to the property owner's language on every turn.
- Automatically reply in the SAME language they use: English, Hindi (hi-IN), or Kannada (kn-IN).
- If they switch languages mid-call, switch with them immediately.
- Keep responses short and natural for phone calls (1-2 sentences).
- Accept yes/no answers in any supported language:
  * English: yes / no
  * Hindi: haan / nahi
  * Kannada: haudu / illa
- If the answer is unclear, politely ask again in their current language.
- Never ask the user to switch to English.
`.trim();
  }

  private detectLanguage(text: string): LanguageCode {
    const kannadaChars = (text.match(KANNADA_RE) ?? []).length;
    const devanagariChars = (text.match(DEVANAGARI_RE) ?? []).length;
    const latinChars = (text.match(LATIN_RE) ?? []).length;

    if (kannadaChars > devanagariChars && kannadaChars > 0) return 'kn-IN';
    if (devanagariChars > kannadaChars && devanagariChars > 0) return 'hi-IN';
    if (latinChars > 0) return 'en-IN';
    return 'unknown';
  }

  private resolveIntent(text: string): {
    affirmative: boolean | null;
    negative: boolean | null;
  } {
    const strongYes = this.matchesKeywordSets(text, STRONG_AFFIRMATIVE);
    const strongNo = this.matchesKeywordSets(text, STRONG_NEGATIVE);

    if (strongYes && !strongNo) return { affirmative: true, negative: null };
    if (strongNo && !strongYes) return { affirmative: null, negative: true };
    if (strongYes && strongNo) return { affirmative: null, negative: null };

    const weakYes = this.matchesKeywordSets(text, WEAK_AFFIRMATIVE);
    const weakNo = this.matchesKeywordSets(text, WEAK_NEGATIVE);

    if (weakYes && !weakNo) return { affirmative: true, negative: null };
    if (weakNo && !weakYes) return { affirmative: null, negative: true };
    return { affirmative: null, negative: null };
  }

  private matchesKeywordSets(text: string, keywordMap: Record<string, Set<string>>): boolean {
    const tokens = new Set(text.match(/\p{L}+/gu) ?? []);
    for (const keywords of Object.values(keywordMap)) {
      for (const token of tokens) {
        if (keywords.has(token)) return true;
      }
      for (const keyword of keywords) {
        if (text.includes(keyword)) return true;
      }
    }
    return false;
  }
}
