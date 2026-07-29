export type LanguageCode = 'en-IN' | 'hi-IN' | 'kn-IN' | 'unknown';

export interface LanguageDetectionResult {
  language: LanguageCode;
  confidence: number;
  isAffirmative: boolean | null;
  isNegative: boolean | null;
}

const STRONG_AFFIRMATIVE: Record<string, Set<string>> = {
  'en-IN': new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'ok', 'okay']),
  'hi-IN': new Set([
    'haan',
    'han',
    'ha',
    'bilkul',
    'haa',
    'बिल्कुल',
    'बिलकुल',
    'हाँ',
    'हां',
  ]),
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

/** Unambiguous standalone availability answers safe enough to bypass the LLM. */
const FAST_PATH_YES = new Set([
  'yes',
  'haan',
  'han',
  'haa',
  'हाँ',
  'हां',
  'haudu',
  'houdu',
  'howdu',
  'ಹೌದು',
  'available',
  'बिल्कुल',
  'बिलकुल',
  'ಹೌದ್ರಿ',
]);

const FAST_PATH_NO = new Set([
  'no',
  'nahi',
  'nahin',
  'nhi',
  'नहीं',
  'illa',
  'ಇಲ್ಲ',
  'unavailable',
]);

/** Politeness/copula words allowed around an otherwise unambiguous short yes/no. */
const SHORT_YES_NO_FILLERS = new Set([
  'ji',
  'जी',
  'hai',
  'he',
  'है',
  'it',
  'is',
  'ಇದೆ',
]);

const DEVANAGARI_RE = /[\u0900-\u097F]/g;
const KANNADA_RE = /[\u0C80-\u0CFF]/g;
const LATIN_RE = /[a-zA-Z]/g;
const WORD_TOKEN_RE = /[\p{L}\p{M}]+/gu;

const UNSUPPORTED_SCRIPT_CODES: Array<[RegExp, string]> = [
  [/\p{Script=Malayalam}/u, 'ml-IN'],
  [/\p{Script=Tamil}/u, 'ta-IN'],
  [/\p{Script=Telugu}/u, 'te-IN'],
  [/\p{Script=Gujarati}/u, 'gu-IN'],
  [/\p{Script=Gurmukhi}/u, 'pa-IN'],
  [/\p{Script=Bengali}/u, 'bn-IN'],
  [/\p{Script=Oriya}/u, 'or-IN'],
  [/\p{Script=Arabic}/u, 'unsupported'],
  [/\p{Script=Sinhala}/u, 'unsupported'],
];

function isAllowedLanguageCharacter(character: string): boolean {
  if (!/[\p{L}\p{M}]/u.test(character)) return true;
  return /[\p{Script=Latin}\p{Script=Devanagari}\p{Script=Kannada}]/u.test(
    character,
  );
}

const TTS_SPEAKERS: Record<string, string> = {
  'en-IN': 'aditya',
  'hi-IN': 'aditya',
  'kn-IN': 'aditya',
};

function wordTokens(text: string): string[] {
  return text.toLowerCase().match(WORD_TOKEN_RE) ?? [];
}

/**
 * Remove words written in scripts outside English, Hindi, and Kannada.
 * This is primarily for STT artifacts such as a stray Malayalam filler before
 * an otherwise English sentence. Pure unsupported-language turns become empty.
 */
export function stripUnsupportedLanguageFragments(text: string): string {
  let result = '';
  let droppingMarks = false;

  for (const character of text) {
    if (/\p{L}/u.test(character)) {
      droppingMarks = !isAllowedLanguageCharacter(character);
      if (!droppingMarks) result += character;
      continue;
    }
    if (/\p{M}/u.test(character)) {
      if (!droppingMarks && isAllowedLanguageCharacter(character)) {
        result += character;
      }
      continue;
    }
    droppingMarks = false;
    result += character;
  }

  return result
    .replace(/^\s*[.,!?;:।]+\s*/u, '')
    .replace(/\s+([.,!?;:।])/gu, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

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

    // Explicit "speak in English/Hindi/Kannada" wins over STT guesses.
    const explicit = LanguageManager.detectExplicitLanguageRequest(trimmed);
    if (explicit) return explicit;

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

    // Switch to English when the utterance is clearly Latin / English.
    if (fromScript === 'en-IN' && wordTokens(trimmed).length >= 3) {
      return 'en-IN';
    }

    // Do not switch to Hindi/Kannada from STT alone — that causes false flaps.
    // Only allow STT to confirm English when script already looks English.
    if (
      fromStt === 'en-IN' &&
      fromScript === 'en-IN' &&
      fromStt !== this.currentLanguage
    ) {
      const tokenCount = wordTokens(trimmed).length;
      if (tokenCount >= 3) return 'en-IN';
    }

    return null;
  }

  /**
   * Detect an explicit request to change language ("please speak in English").
   */
  static detectExplicitLanguageRequest(text: string): LanguageCode | null {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return null;

    if (
      /\b(in|to|speak|talk|switch(?:\s+to)?)\s+english\b/.test(normalized) ||
      /\benglish\s+please\b/.test(normalized) ||
      /\bplease\s+(speak|talk)\s+english\b/.test(normalized)
    ) {
      return 'en-IN';
    }

    if (
      /\b(in|to|speak|talk|switch(?:\s+to)?)\s+hindi\b/.test(normalized) ||
      /\bhindi\s+please\b/.test(normalized) ||
      /हिंदी|हिन्दी/.test(text)
    ) {
      return 'hi-IN';
    }

    if (
      /\b(in|to|speak|talk|switch(?:\s+to)?)\s+kannada\b/.test(normalized) ||
      /\bkannada\s+please\b/.test(normalized) ||
      /ಕನ್ನಡ/.test(text)
    ) {
      return 'kn-IN';
    }

    return null;
  }

  /**
   * Detect languages recognized by STT but unsupported by this call pipeline.
   * Keep this separate from LanguageCode so unsupported languages are never
   * accidentally passed into TTS updateOptions.
   */
  static detectUnsupportedLanguage(
    text: string,
    sttRaw?: string | null,
  ): string | null {
    // Auto-detect sometimes renders a Hindi yes/no in a neighboring script.
    if (LanguageManager.isShortYesNo(text)) return null;

    const stt = sttRaw?.trim().toLowerCase();
    for (const [script, code] of UNSUPPORTED_SCRIPT_CODES) {
      if (script.test(text)) return code;
    }
    if (
      [...text].some(
        (character) =>
          /[\p{L}\p{M}]/u.test(character) &&
          !isAllowedLanguageCharacter(character),
      )
    ) {
      return 'unsupported';
    }
    if (
      stt &&
      /^[a-z]{2}(?:-|$)/.test(stt) &&
      !LanguageManager.normalizeLanguageCode(stt)
    ) {
      return stt;
    }
    return null;
  }

  /** True for short availability answers that should not change conversation language. */
  static isShortYesNo(text: string): boolean {
    const tokens = wordTokens(text.trim());
    if (tokens.length === 0 || tokens.length > 4) return false;
    const meaningful = tokens.filter((token) => !SHORT_YES_NO_FILLERS.has(token));
    return (
      meaningful.length > 0 &&
      (meaningful.every((token) => FAST_PATH_YES.has(token)) ||
        meaningful.every((token) => FAST_PATH_NO.has(token)))
    );
  }

  /** Strong enough to switch TTS immediately instead of waiting for confirmation. */
  static hasStrongLanguageSwitchEvidence(text: string): boolean {
    if (LanguageManager.detectExplicitLanguageRequest(text)) return true;
    return wordTokens(text.trim()).length >= 3;
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
    const tokens = new Set(wordTokens(text));
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
    const tokens = new Set(wordTokens(text));
    for (const keywords of Object.values(keywordMap)) {
      for (const keyword of keywords) {
        if (tokens.has(keyword)) return true;
        // Native-script keywords may not always tokenize cleanly.
        if (/[^\u0000-\u007f]/.test(keyword) && text.includes(keyword)) return true;
      }
    }
    return false;
  }
}
