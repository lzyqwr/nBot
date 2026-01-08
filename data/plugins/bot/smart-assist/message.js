export function summarizeMentions(ctx) {
  const out = { bot: false, other: false, all: false, any: false };
  if (!ctx) return out;
  if (ctx.at_bot === true) {
    out.bot = true;
    out.any = true;
  }

  const selfId = ctx.self_id !== undefined && ctx.self_id !== null ? String(ctx.self_id) : "";
  const segments = Array.isArray(ctx.message) ? ctx.message : null;
  if (!segments) return out;

  for (const seg of segments) {
    if (!seg || seg.type !== "at") continue;
    const qq = seg.data && seg.data.qq !== undefined ? String(seg.data.qq).trim() : "";
    if (!qq) continue;
    out.any = true;
    if (qq.toLowerCase() === "all") {
      out.all = true;
      continue;
    }
    if (selfId && qq === selfId) {
      out.bot = true;
      continue;
    }
    out.other = true;
  }
  return out;
}

export function sanitizeMessageForLlm(text, ctx) {
  const s = String(text || "");
  if (!s) return "";

  const selfId = ctx && ctx.self_id !== undefined && ctx.self_id !== null ? String(ctx.self_id) : "";

  // Prefer structured segments from ctx.message (backend enriches face segments with `data.name`).
  if (ctx && Array.isArray(ctx.message) && ctx.message.length) {
    const parts = [];
    for (const seg of ctx.message) {
      if (!seg || typeof seg !== "object") continue;
      const type = String(seg.type || "").toLowerCase();
      const data = seg.data && typeof seg.data === "object" ? seg.data : {};
      if (type === "text") {
        const t = data.text !== undefined ? String(data.text) : "";
        if (t) parts.push(t);
        continue;
      }
      if (type === "at") {
        const qq = data.qq !== undefined ? String(data.qq).trim() : "";
        if (!qq) {
          parts.push("@他人");
        } else if (qq.toLowerCase() === "all") {
          parts.push("@全体");
        } else if (selfId && qq === selfId) {
          parts.push("@机器人");
        } else {
          parts.push("@他人");
        }
        continue;
      }
      if (type === "face") {
        const name = data.name !== undefined ? String(data.name).trim() : "";
        const id = data.id !== undefined ? String(data.id).trim() : "";
        if (name) parts.push(`[表情:${name}]`);
        else if (id) parts.push(`[表情:${id}]`);
        else parts.push("[表情]");
        continue;
      }
      if (type === "mface") {
        parts.push("[表情]");
        continue;
      }
      if (type === "image") {
        parts.push("[图片]");
        continue;
      }
      if (type === "video") {
        parts.push("[视频]");
        continue;
      }
      if (type === "record") {
        parts.push("[语音]");
        continue;
      }
      if (type === "file") {
        parts.push("[文件]");
        continue;
      }
      if (type === "reply") {
        continue;
      }
      if (type === "json" || type === "xml" || type === "markdown") {
        parts.push("[卡片]");
        continue;
      }
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  // Fallback: sanitize raw CQ string.
  return s
    .replace(/\[CQ:at,([^\]]+)\]/g, (_m, inner) => {
      const m = String(inner || "").match(/(?:^|,)qq=([^,]+)(?:,|$)/i);
      const qq = m && m[1] ? String(m[1]).trim() : "";
      if (!qq) return "@他人";
      if (qq.toLowerCase() === "all") return "@全体";
      if (selfId && qq === selfId) return "@机器人";
      return "@他人";
    })
    .replace(/\[CQ:reply,[^\]]*\]/g, " ")
    .replace(/\[CQ:face,[^\]]*\]/gi, "[表情]")
    .replace(/\[CQ:mface,[^\]]*\]/g, "[表情]")
    .replace(/\[CQ:image,[^\]]*\]/g, "[图片]")
    .replace(/\[CQ:video,[^\]]*\]/g, "[视频]")
    .replace(/\[CQ:record,[^\]]*\]/g, "[语音]")
    .replace(/\[CQ:file,[^\]]*\]/g, "[文件]")
    .replace(/\[CQ:(?:xml|json),[^\]]*\]/g, "[卡片]")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMentioningBot(ctx) {
  if (!ctx) return false;
  if (ctx.at_bot === true) return true;

  const selfId = ctx.self_id;
  if (!selfId) return false;

  const segments = ctx.message;
  if (Array.isArray(segments)) {
    for (const seg of segments) {
      if (!seg || seg.type !== "at") continue;
      const qq = seg.data && seg.data.qq !== undefined ? String(seg.data.qq) : "";
      if (qq && qq === String(selfId)) {
        return true;
      }
    }
  }

  const raw = String(ctx.raw_message || "");
  if (raw && raw.includes(`[CQ:at,qq=${selfId}]`)) {
    return true;
  }

  return false;
}

