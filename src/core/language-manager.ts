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

  /**
   * Decide conversation language for a turn without flipping on short yes/no answers.
   * Returns null when the language should stay as-is (caller should not retune TTS).
   */
  resolveSpokenLanguage(
    transcript: string,
    sttRaw?: string | null,
  ): LanguageCode | null {
    const trimmed = transcript.trim();
    if (!trimmed) return null;

    if (LanguageManager.isShortYesNo(trimmed)) {
      return null;
    }

    const fromStt = LanguageManager.normalizeLanguageCode(sttRaw);
    const fromScript = this.detectScriptLanguage(trimmed);
    const fromKeywords = this.detectRomanizedLanguage(trimmed);

    // Native script is the strongest signal.
    if (fromScript === 'hi-IN' || fromScript === 'kn-IN') {
      return fromScript;
    }

    // Explicit Romanized Hindi/Kannada words (haan / haudu), not bare yes/no.
    if (fromKeywords === 'hi-IN' || fromKeywords === 'kn-IN') {
      return fromKeywords;
    }

    if (fromStt && fromStt !== this.currentLanguage) {
      // Trust STT only when the utterance is long enough to be a real switch.
      const tokenCount = (trimmed.match(/\p{L}+/gu) ?? []).length;
      if (tokenCount >= 3 || fromScript === 'en-IN') {
        return fromStt;
      }
    }

    if (fromScript === 'en-IN' && (trimmed.match(/\p{L}+/gu) ?? []).length >= 3) {
      return 'en-IN';
    }

    return null;
  }

  /** True for short availability answers that should not change conversation language. */
  static isShortYesNo(text: string): boolean {
    const tokens = text.trim().toLowerCase().match(/\p{L}+/gu) ?? [];
    if (tokens.length === 0 || tokens.length > 3) return false;

    const yesNo = new Set<string>([
      ...STRONG_AFFIRMATIVE['en-IN']!,
      ...STRONG_AFFIRMATIVE['hi-IN']!,
      ...STRONG_AFFIRMATIVE['kn-IN']!,
      ...STRONG_NEGATIVE['en-IN']!,
      ...STRONG_NEGATIVE['hi-IN']!,
      ...STRONG_NEGATIVE['kn-IN']!,
      'available',
      'unavailable',
    ]);

    return tokens.every((token) => yesNo.has(token));
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

    if (language !== 'unknown' && !LanguageManager.isShortYesNo(normalized)) {
      this.currentLanguage = language;
    }

    return {
      language:
        language !== 'unknown' && !LanguageManager.isShortYesNo(normalized)
          ? language
          : this.currentLanguage,
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

  /** Normalize STT / metadata codes like `hi`, `en`, `kn-IN` → supported LanguageCode. */
  static normalizeLanguageCode(raw: string | null | undefined): LanguageCode | null {
    if (!raw) return null;
    const value = raw.trim().toLowerCase();
    if (value.startsWith('hi')) return 'hi-IN';
    if (value.startsWith('kn')) return 'kn-IN';
    if (value.startsWith('en')) return 'en-IN';
    return null;
  }

  static multilingualInstructions(): string {
    return `
Language rules (critical):
- Listen to the property owner's language on every turn.
- Automatically reply in the SAME language they use: English, Hindi (hi-IN), or Kannada (kn-IN).
- If they switch languages mid-call with a full sentence, switch with them and call switchConversationLanguage once.
- Do not treat short yes/no answers (yes, no, haan, nahi, haudu, illa) as a language switch.
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
    const fromKeywords = this.detectRomanizedLanguage(text);
    if (fromKeywords !== 'unknown') return fromKeywords;
    return this.detectScriptLanguage(text);
  }

  private detectRomanizedLanguage(text: string): LanguageCode {
    if (this.matchesLanguageKeywords(text, 'hi-IN')) return 'hi-IN';
    if (this.matchesLanguageKeywords(text, 'kn-IN')) return 'kn-IN';
    return 'unknown';
  }

  private detectScriptLanguage(text: string): LanguageCode {
    const kannadaChars = (text.match(KANNADA_RE) ?? []).length;
    const devanagariChars = (text.match(DEVANAGARI_RE) ?? []).length;
    const latinChars = (text.match(LATIN_RE) ?? []).length;

    if (kannadaChars > devanagariChars && kannadaChars > 0) return 'kn-IN';
    if (devanagariChars > kannadaChars && devanagariChars > 0) return 'hi-IN';
    if (latinChars > 0) return 'en-IN';
    return 'unknown';
  }

  private matchesLanguageKeywords(
    text: string,
    language: 'hi-IN' | 'kn-IN',
  ): boolean {
    const tokens = new Set(text.match(/\p{L}+/gu) ?? []);
    const keywords = [
      ...STRONG_AFFIRMATIVE[language]!,
      ...STRONG_NEGATIVE[language]!,
    ];
    return keywords.some((keyword) => tokens.has(keyword));
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
