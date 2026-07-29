import type { LanguageCode } from '../core/language-manager.js';

export const DEFAULT_GOODBYE_TEXT = 'Thanks, goodbye.';
export type AvailabilityOutcome = 'yes' | 'no';

export interface BrandingParams {
  companyName: string;
  companyWebsite: string;
}

export interface OpeningScriptParams extends BrandingParams {
  callerName: string;
  propertyAddress: string;
  bhk?: string;
  locality?: string;
  rentAmount?: number;
}

/** Scripted opening — short, conversational TTS with no LLM round-trip. */
export function openingForLanguage(
  params: OpeningScriptParams,
  language: LanguageCode = 'en-IN',
): string {
  const { companyName } = params;
  const configuration = params.bhk?.trim();
  const property = configuration ? `${configuration} property` : 'property';
  const locality = params.locality?.trim();
  const rent = params.rentAmount
    ? params.rentAmount.toLocaleString('en-IN')
    : undefined;

  if (language === 'hi-IN') {
    return (
      `Hi, ${companyName} से बोल रहे हैं। आपकी ${property}` +
      `${locality ? ` ${locality} में` : ''}` +
      `${rent ? ` ${rent} rupees rent पर` : ''} अभी available है?`
    );
  }

  if (language === 'kn-IN') {
    return (
      `Hi, ${companyName} ಇಂದ call ಮಾಡುತ್ತಿದ್ದೇವೆ. ನಿಮ್ಮ ${property}` +
      `${locality ? ` ${locality} ನಲ್ಲಿ` : ''}` +
      `${rent ? ` ${rent} rupees rent ಗೆ` : ''} ಇನ್ನೂ available ಇದೆಯಾ?`
    );
  }

  return (
    `Hi, this is ${companyName}. Is your ${configuration ?? 'property'}` +
    `${locality ? ` in ${locality}` : ''}` +
    `${rent ? ` at ${rent} rupees a month` : ''} still available?`
  );
}

/** Scripted closing after availability is recorded — intentionally brief. */
export function availabilityClosing(
  outcome: AvailabilityOutcome,
  language: LanguageCode = 'en-IN',
  branding: BrandingParams = {
    companyName: 'Galynest',
    companyWebsite: 'galynest.com',
  },
): string {
  const { companyName } = branding;

  if (language === 'hi-IN') {
    return outcome === 'yes'
      ? `Great, thank you। Tenant मिलते ही ${companyName} team आपको call करेगी।`
      : 'ठीक है, thank you। हम listing update कर देंगे और इसके लिए दोबारा call नहीं करेंगे।';
  }

  if (language === 'kn-IN') {
    return outcome === 'yes'
      ? `Great, thank you. Tenant ಸಿಕ್ಕ ತಕ್ಷಣ ${companyName} team ನಿಮಗೆ call ಮಾಡುತ್ತದೆ.`
      : 'ಸರಿ, thank you. ನಾವು listing update ಮಾಡುತ್ತೇವೆ ಮತ್ತು ಇದರ ಬಗ್ಗೆ ಮತ್ತೆ call ಮಾಡುವುದಿಲ್ಲ.';
  }

  if (outcome === 'yes') {
    return `Great, thank you. The ${companyName} team will call when we find a matching tenant.`;
  }

  return "Got it, thank you. We'll update the listing and won't call again about it.";
}

export function goodbyeForLanguage(language: LanguageCode): string {
  if (language === 'hi-IN') return 'ठीक है, thank you।';
  if (language === 'kn-IN') return 'ಸರಿ, thank you.';
  return DEFAULT_GOODBYE_TEXT;
}

/** Closing when the callee says they do not own the property. */
export function ownershipMismatchClosing(language: LanguageCode): string {
  if (language === 'hi-IN') {
    return 'Sorry, लगता है हमारे records में गलती है। हम इसे update कर देंगे और दोबारा call नहीं करेंगे।';
  }
  if (language === 'kn-IN') {
    return 'Sorry, ನಮ್ಮ records ನಲ್ಲಿ ತಪ್ಪಿದೆ. ನಾವು update ಮಾಡುತ್ತೇವೆ ಮತ್ತು ಮತ್ತೆ call ಮಾಡುವುದಿಲ್ಲ.';
  }
  return "Sorry, our records seem to be wrong. We'll update them and won't call again.";
}
