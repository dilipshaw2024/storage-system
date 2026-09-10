/**
 * Strip HTML tags for keyword scanning (POC — not a full HTML parser).
 */
export function stripHtmlForScan(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Normalize text for substring keyword scans (lowercase, hyphen/underscore → space, collapse spaces).
 */
export function normalizeForKeywordScan(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns which configured keywords match (case-insensitive substring).
 * Haystack is normalized so "Claim-Form" matches "Claim Form", etc.
 * For keywords ending in "s" (e.g. "Claims"), also matches the singular stem ("Claim")
 * so subjects like "Claim Number …" are detected.
 */
export function findMatchedClaimKeywords(text: string, keywords: string[]): string[] {
  if (!text || keywords.length === 0) return [];
  const haystack = normalizeForKeywordScan(text);
  const matched: string[] = [];

  for (const kw of keywords) {
    if (!kw) continue;
    const raw = kw.trim();
    const needle = normalizeForKeywordScan(raw);
    if (!needle) continue;

    if (haystack.includes(needle)) {
      matched.push(raw);
      continue;
    }

    // Plural keyword → singular: "Claims" matches "Claim …" but not "Claimant" falsely if we're careful
    if (needle.length > 3 && needle.endsWith("s") && !needle.endsWith("ss")) {
      const singular = needle.slice(0, -1);
      if (singular.length >= 3) {
        const re = new RegExp(`\\b${escapeRegExp(singular)}\\b`, "i");
        if (re.test(haystack)) {
          matched.push(raw);
        }
      }
    }
  }

  return matched;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
