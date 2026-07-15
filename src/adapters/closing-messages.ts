import type { LanguageCode } from '../core/language-manager.js';

export const DEFAULT_GOODBYE_TEXT = 'Thank you. Goodbye.';
export type AvailabilityOutcome = 'yes' | 'no';

/** Scripted closing when the LLM fails to speak its own closing in time. */
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
