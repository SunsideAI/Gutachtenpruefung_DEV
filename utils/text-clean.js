function cleanText(text) {
  if (!text) return text;
  let cleaned = text;
  // Remove machine-generated references
  cleaned = cleaned.replace(/\(vgl\.\s*citeturn[^)]*\)/g, '');
  cleaned = cleaned.replace(/\(citeturn[^)]*\)/g, '');
  cleaned = cleaned.replace(/citeturn\d*file\d*\S*/g, '');
  cleaned = cleaned.replace(/turnfile\d+\S*/g, '');
  cleaned = cleaned.replace(/\bfile\s+\d+\b/gi, '');
  // Collapse multiple spaces and trim
  cleaned = cleaned.replace(/  +/g, ' ').trim();
  return cleaned;
}

module.exports = { cleanText };
