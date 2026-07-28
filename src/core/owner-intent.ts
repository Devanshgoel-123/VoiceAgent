const OWNERSHIP_MISMATCH_PATTERNS = [
  /\b(?:this|that|the)\s+(?:property|listing)\s+(?:is\s+)?not\s+mine\b/i,
  /\b(?:it|this|that)\s+isn['’]t\s+mine\b/i,
  /\bi\s+(?:do\s+not|don['’]t)\s+own\s+(?:this|that|the)\s+(?:property|listing)\b/i,
  /\bi(?:'m|\s+am)\s+not\s+the\s+owner\b/i,
  /\bwrong\s+(?:number|person)\b/i,
  /(?:यह|ये|वह|वो)\s+(?:प्रॉपर्टी|संपत्ति|जायदाद)\s+मेरी\s+नहीं/u,
  /(?:प्रॉपर्टी|संपत्ति|जायदाद)\s+मेरी\s+नहीं/u,
  /मैं\s+(?:इस\s+)?(?:प्रॉपर्टी|संपत्ति|जायदाद)\s+का\s+मालिक\s+नहीं/u,
  /मैं\s+मालिक\s+नहीं/u,
  /गलत\s+नंबर/u,
  /(?:ಈ|ಆ)\s+(?:ಪ್ರಾಪರ್ಟಿ|ಆಸ್ತಿ)\s+ನನ್ನದಲ್ಲ/u,
  /ನಾನು\s+ಮಾಲೀಕನಲ್ಲ/u,
  /ತಪ್ಪು\s+ನಂಬರ್/u,
];

/** True when the callee says they do not own/recognize this listing. */
export function isOwnershipMismatch(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return OWNERSHIP_MISMATCH_PATTERNS.some((pattern) => pattern.test(normalized));
}
