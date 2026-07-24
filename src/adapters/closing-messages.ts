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
  const { callerName, companyName, propertyAddress } = params;

  if (language === 'hi-IN') {
    return (
      `नमस्ते, मैं ${callerName} बोल रहा हूँ ${companyName} से। ` +
      `मैं ${propertyAddress} वाली प्रॉपर्टी के बारे में कॉल कर रहा हूँ। ` +
      `क्या यह किराये के लिए अभी भी उपलब्ध है?`
    );
  }

  if (language === 'kn-IN') {
    return (
      `ನಮಸ್ಕಾರ, ನಾನು ${callerName}, ${companyName} ನಿಂದ ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ. ` +
      `ನಾನು ${propertyAddress} ನಲ್ಲಿರುವ ಪ್ರಾಪರ್ಟಿ ಬಗ್ಗೆ ಕರೆ ಮಾಡುತ್ತಿದ್ದೇನೆ. ` +
      `ಇದು ಇನ್ನೂ ಬಾಡಿಗೆಗೆ ಲಭ್ಯವಿದೆಯೇ?`
    );
  }

  return (
    `Hi, this is ${callerName} from ${companyName}. ` +
    `I'm calling about the property at ${propertyAddress}. ` +
    `Is it still available for rent?`
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
