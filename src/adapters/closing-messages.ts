import type { LanguageCode } from '../core/language-manager.js';

export const DEFAULT_GOODBYE_TEXT = 'Thank you. Goodbye.';
export type AvailabilityOutcome = 'yes' | 'no';

export interface OpeningScriptParams {
  callerName: string;
  companyName: string;
  propertyAddress: string;
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
): string {
  if (language === 'hi-IN') {
    return outcome === 'yes'
      ? 'धन्यवाद। गुल्लीनेस्ट टीम आपके लिए किरायेदार ढूँढना जारी रखेगी। जैसे ही हमें आपके लिए किरायेदार मिलेगा, हम आपको कॉल करेंगे। कृपया इस नंबर को गुल्लीनेस्ट प्रॉपर्टी टीम के नाम से सेव कर लें। आपका दिन शुभ हो।'
      : 'जानकारी देने के लिए धन्यवाद। हम अपने रिकॉर्ड अपडेट कर देंगे और आपको दोबारा परेशान नहीं करेंगे। अगर भविष्य में आपको किरायेदार ढूँढना हो, तो गुल्लीनेस्ट डॉट कॉम पर जाएँ। आपका दिन शुभ हो।';
  }

  if (language === 'kn-IN') {
    return outcome === 'yes'
      ? 'ಧನ್ಯವಾದಗಳು. ಗುಲ್ಲಿನೆಸ್ಟ್ ತಂಡವು ನಿಮಗಾಗಿ ಬಾಡಿಗೆದಾರರನ್ನು ಹುಡುಕುವುದನ್ನು ಮುಂದುವರಿಸುತ್ತದೆ. ನಿಮಗಾಗಿ ಬಾಡಿಗೆದಾರರು ಸಿಕ್ಕ ತಕ್ಷಣ ನಾವು ನಿಮಗೆ ಕರೆ ಮಾಡುತ್ತೇವೆ. ದಯವಿಟ್ಟು ಈ ಸಂಖ್ಯೆಯನ್ನು ಗುಲ್ಲಿನೆಸ್ಟ್ ಪ್ರಾಪರ್ಟಿ ಟೀಮ್ ಎಂದು ಸೇವ್ ಮಾಡಿಕೊಳ್ಳಿ. ನಿಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ.'
      : 'ಮಾಹಿತಿ ನೀಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಾವು ನಮ್ಮ ದಾಖಲೆಗಳನ್ನು ನವೀಕರಿಸುತ್ತೇವೆ ಮತ್ತು ನಿಮಗೆ ಮತ್ತೆ ತೊಂದರೆ ನೀಡುವುದಿಲ್ಲ. ಭವಿಷ್ಯದಲ್ಲಿ ಬಾಡಿಗೆದಾರರನ್ನು ಹುಡುಕಬೇಕಾದರೆ, ಗುಲ್ಲಿನೆಸ್ಟ್ ಡಾಟ್ ಕಾಮ್‌ಗೆ ಭೇಟಿ ನೀಡಿ. ನಿಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ.';
  }

  if (outcome === 'yes') {
    return (
      'Thank you. The Galiynest team will continue searching for tenants. ' +
      'We will call you as soon as we find a tenant for you. ' +
      'We recommend saving this number as Galynest Property Team. ' +
      'Have a good day.'
    );
  }

  return (
    'Thank you for the information. We will update our records and will not disturb you again. ' +
    'If you want to search for a tenant in the future, simply visit Galynest dot com. ' +
    'Have a good day.'
  );
}

export function goodbyeForLanguage(language: LanguageCode): string {
  if (language === 'hi-IN') return 'धन्यवाद।';
  if (language === 'kn-IN') return 'ಧನ್ಯವಾದಗಳು।';
  return DEFAULT_GOODBYE_TEXT;
}
