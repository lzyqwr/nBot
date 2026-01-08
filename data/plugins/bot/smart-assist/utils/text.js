export function containsKeyword(text, keywords) {
  if (!text || !keywords || keywords.length === 0) return false;
  const lowerText = String(text).toLowerCase();
  return keywords.some((kw) => lowerText.includes(String(kw || "").toLowerCase()));
}

export function stripLeadingCqSegments(text) {
  let s = String(text || "").trim();
  while (s.startsWith("[CQ:")) {
    const end = s.indexOf("]");
    if (end < 0) break;
    s = s.slice(end + 1).trimStart();
  }
  return s.trim();
}

export function stripAllCqSegments(text) {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

