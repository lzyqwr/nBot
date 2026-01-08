export function maskSensitiveForLog(text) {
  return String(text || "")
    // mask long digit sequences (QQ/IDs/etc)
    .replace(/\d{5,}/g, "***")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeForLog(text, maxLen = 600) {
  let s = "";
  try {
    s = JSON.stringify(String(text || ""));
  } catch {
    s = String(text || "");
  }
  s = maskSensitiveForLog(s);
  if (s.length > maxLen) s = s.slice(0, maxLen) + "...";
  return s;
}

