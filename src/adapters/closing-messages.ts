import type { LanguageCode } from '../core/language-manager.js';

export const DEFAULT_GOODBYE_TEXT = 'Thank you. Goodbye.';
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

function spokenWebsite(website: string, language: LanguageCode): string {
  const host = website.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (language === 'hi-IN') {
    return host.replace(/\./g, ' डॉट ');
  }
  if (language === 'kn-IN') {
    return host.replace(/\./g, ' ಡಾಟ್ ');
  }
  return host.replace(/\./g, ' dot ');
}

function teamLabel(companyName: string, language: LanguageCode): string {
  if (language === 'hi-IN') return `${companyName} प्रॉपर्टी टीम`;
  if (language === 'kn-IN') return `${companyName} ಪ್ರಾಪರ್ಟಿ ಟೀಮ್`;
  return `${companyName} Property Team`;
}

/** Scripted opening — TTS only, no LLM. */
export function openingForLanguage(
  params: OpeningScriptParams,
  language: LanguageCode = 'en-IN',
): string {
  const { companyName } = params;
  const property = params.bhk?.trim() || 'property';
  const locality = params.locality?.trim();
  const rent = params.rentAmount
    ? params.rentAmount.toLocaleString('en-IN')
    : undefined;

  if (language === 'hi-IN') {
    return (
      `नमस्ते, यह ${companyName} से कॉल है। हमने आपकी ${property} संपत्ति` +
      `${locality ? ` ${locality} में` : ''}` +
      `${rent ? ` ${rent} रुपये प्रति माह में` : ''} लिस्ट की थी। ` +
      'बस पुष्टि करनी थी, क्या यह अभी भी उपलब्ध है?'
    );
  }

  if (language === 'kn-IN') {
    return (
      `ನಮಸ್ಕಾರ, ಇದು ${companyName} ನಿಂದ ಕರೆ. ನಾವು ನಿಮ್ಮ ${property} ಸಂपत्तಿ` +
      `${locality ? ` ಅನ್ನು ${locality} ನಲ್ಲಿ` : ''}` +
      `${rent ? ` ತಿಂಗಳಿಗೆ ${rent} ರೂಪಾಯಿಗೆ` : ''} ಲಿಸ್ಟ್ ಮಾಡಿದ್ದೇವೆ. ` +
      'ಇದು ಇನ್ನೂ ಲಭ್ಯವಿದೆಯೇ ಎಂದು ಖಚಿತಪಡಿಸಿಕೊಳ್ಳಲು ಕರೆ ಮಾಡಿದ್ದೇವೆ.'
    );
  }

  return (
    `Hi, this is ${companyName}. We'd listed your ${property} property` +
    `${locality ? ` in ${locality}` : ''}` +
    `${rent ? ` for ${rent} rupees a month` : ''} — ` +
    'just confirming, is it still available?'
  );
}

/** Scripted closing after availability is recorded — no post-tool LLM turn. */
export function availabilityClosing(
  outcome: AvailabilityOutcome,
  language: LanguageCode = 'en-IN',
  branding: BrandingParams = {
    companyName: 'Galynest',
    companyWebsite: 'galynest.com',
  },
): string {
  const { companyName, companyWebsite } = branding;
  const team = teamLabel(companyName, language);
  const site = spokenWebsite(companyWebsite, language);

  if (language === 'hi-IN') {
    return outcome === 'yes'
      ? `धन्यवाद। ${companyName} टीम आपके लिए किरायेदार ढूँढना जारी रखेगी। जैसे ही हमें आपके लिए किरायेदार मिलेगा, हम आपको कॉल करेंगे। कृपया इस नंबर को ${team} के नाम से सेव कर लें। आपका दिन शुभ हो।`
      : `जानकारी देने के लिए धन्यवाद। हम अपने रिकॉर्ड अपडेट कर देंगे और आपको दोबारा परेशान नहीं करेंगे। अगर भविष्य में आपको किरायेदार ढूँढना हो, तो ${site} पर जाएँ। आपका दिन शुभ हो।`;
  }

  if (language === 'kn-IN') {
    return outcome === 'yes'
      ? `ಧನ್ಯವಾದಗಳು. ${companyName} ತಂಡವು ನಿಮಗಾಗಿ ಬಾಡಿಗೆದಾರರನ್ನು ಹುಡುಕುವುದನ್ನು ಮುಂದುವರಿಸುತ್ತದೆ. ನಿಮಗಾಗಿ ಬಾಡಿಗೆದಾರರು ಸಿಕ್ಕ ತಕ್ಷಣ ನಾವು ನಿಮಗೆ ಕರೆ ಮಾಡುತ್ತೇವೆ. ದಯವಿಟ್ಟು ಈ ಸಂಖ್ಯೆಯನ್ನು ${team} ಎಂದು ಸೇವ್ ಮಾಡಿಕೊಳ್ಳಿ. ನಿಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ.`
      : `ಮಾಹಿತಿ ನೀಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಾವು ನಮ್ಮ ದಾಖಲೆಗಳನ್ನು ನವೀಕರಿಸುತ್ತೇವೆ ಮತ್ತು ನಿಮಗೆ ಮತ್ತೆ ತೊಂದರೆ ನೀಡುವುದಿಲ್ಲ. ಭವಿಷ್ಯದಲ್ಲಿ ಬಾಡಿಗೆದಾರರನ್ನು ಹುಡುಕಬೇಕಾದರೆ, ${site} ಗೆ ಭೇಟಿ ನೀಡಿ. ನಿಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ.`;
  }

  if (outcome === 'yes') {
    return (
      `Thank you. The ${companyName} team will continue searching for tenants. ` +
      'We will call you as soon as we find a tenant for you. ' +
      `We recommend saving this number as ${team}. ` +
      'Have a good day.'
    );
  }

  return (
    'Thank you for the information. We will update our records and will not disturb you again. ' +
    `If you want to search for a tenant in the future, simply visit ${site}. ` +
    'Have a good day.'
  );
}

export function goodbyeForLanguage(language: LanguageCode): string {
  if (language === 'hi-IN') return 'धन्यवाद।';
  if (language === 'kn-IN') return 'ಧನ್ಯವಾದಗಳು।';
  return DEFAULT_GOODBYE_TEXT;
}

/** Closing when the callee says they do not own the property. */
export function ownershipMismatchClosing(language: LanguageCode): string {
  if (language === 'hi-IN') {
    return (
      'माफ़ कीजिए, लगता है हमारे रिकॉर्ड में गलती है। ' +
      'हम अपने रिकॉर्ड अपडेट कर देंगे और इस प्रॉपर्टी के बारे में आपको दोबारा परेशान नहीं करेंगे। ' +
      'आपका दिन शुभ हो।'
    );
  }
  if (language === 'kn-IN') {
    return (
      'ಕ್ಷಮಿಸಿ, ನಮ್ಮ ದಾಖಲೆಗಳಲ್ಲಿ ತಪ್ಪಿರುವಂತೆ ಕಾಣುತ್ತದೆ. ' +
      'ನಾವು ನಮ್ಮ ದಾಖಲೆಗಳನ್ನು ನವೀಕರಿಸುತ್ತೇವೆ ಮತ್ತು ಈ ಪ್ರಾಪರ್ಟಿಯ ಬಗ್ಗೆ ನಿಮಗೆ ಮತ್ತೆ ತೊಂದರೆ ನೀಡುವುದಿಲ್ಲ. ' +
      'ನಿಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ.'
    );
  }
  return (
    "We're sorry, it appears our records are incorrect. " +
    "We'll update them and won't contact you again about this property. " +
    'Have a good day.'
  );
}
