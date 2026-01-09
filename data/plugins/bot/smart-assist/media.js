import {
  recentGroupImages,
  recentGroupRecords,
  recentGroupVideos,
  recentUserImages,
  recentUserRecords,
  recentUserVideos,
} from "./state.js";
import { sanitizeMessageForLlm } from "./message.js";
import { decodeHtmlEntities, stripAllCqSegments } from "./utils/text.js";

export function extractImageUrlsFromCtx(ctx) {
  const urls = [];
  if (ctx && Array.isArray(ctx.message)) {
    for (const seg of ctx.message) {
      if (!seg || seg.type !== "image") continue;
      const u = seg.data && seg.data.url !== undefined ? String(seg.data.url).trim() : "";
      if (u) urls.push(decodeHtmlEntities(u));
    }
  }

  const raw = ctx ? String(ctx.raw_message || "") : "";
  if (raw && raw.includes("[CQ:image")) {
    const re = /\[CQ:image,[^\]]*?\burl=([^\],]+)[^\]]*\]/gi;
    let m;
    while ((m = re.exec(raw))) {
      const u = m[1] ? decodeHtmlEntities(String(m[1]).trim()) : "";
      if (u) urls.push(u);
    }
  }

  // de-dup, keep order
  return [...new Set(urls)].slice(0, 4);
}

export function extractVideoUrlsFromCtx(ctx) {
  const urls = [];
  if (ctx && Array.isArray(ctx.message)) {
    for (const seg of ctx.message) {
      if (!seg || seg.type !== "video") continue;
      const u = seg.data && seg.data.url !== undefined ? String(seg.data.url).trim() : "";
      if (u) urls.push(decodeHtmlEntities(u));
    }
  }

  const raw = ctx ? String(ctx.raw_message || "") : "";
  if (raw && raw.includes("[CQ:video")) {
    const re = /\[CQ:video,[^\]]*?\burl=([^\],]+)[^\]]*\]/gi;
    let m;
    while ((m = re.exec(raw))) {
      const u = m[1] ? decodeHtmlEntities(String(m[1]).trim()) : "";
      if (u) urls.push(u);
    }
  }

  return [...new Set(urls)].filter((u) => /^https?:\/\//i.test(String(u || ""))).slice(0, 2);
}

export function extractRecordUrlsFromCtx(ctx) {
  const urls = [];
  if (ctx && Array.isArray(ctx.message)) {
    for (const seg of ctx.message) {
      if (!seg || seg.type !== "record") continue;
      const u = seg.data && seg.data.url !== undefined ? String(seg.data.url).trim() : "";
      if (u) urls.push(decodeHtmlEntities(u));
    }
  }

  const raw = ctx ? String(ctx.raw_message || "") : "";
  if (raw && raw.includes("[CQ:record")) {
    const re = /\[CQ:record,[^\]]*?\burl=([^\],]+)[^\]]*\]/gi;
    let m;
    while ((m = re.exec(raw))) {
      const u = m[1] ? decodeHtmlEntities(String(m[1]).trim()) : "";
      if (u) urls.push(u);
    }
  }

  return [...new Set(urls)].filter((u) => /^https?:\/\//i.test(String(u || ""))).slice(0, 2);
}

export function extractReplyMessageContext(ctx) {
  const rm = ctx && ctx.reply_message ? ctx.reply_message : null;
  if (!rm) return null;

  const raw = String(rm.raw_message || "");
  const text = sanitizeMessageForLlm(raw, null);
  const snippet = text.length > 240 ? `${text.slice(0, 240)}…` : text;

  const imageUrls = [];
  const videoUrls = [];
  const recordUrls = [];
  const addTo = (arr, u) => {
    const s = String(u || "").trim();
    if (!s) return;
    if (!/^https?:\/\//i.test(s)) return;
    const decoded = decodeHtmlEntities(s);
    if (!arr.includes(decoded)) arr.push(decoded);
  };

  // Prefer media attachments from the replied message.
  addTo(imageUrls, rm.image_url);
  addTo(videoUrls, rm.video_url);
  addTo(recordUrls, rm.record_url);

  // If the replied message is a forward, it may contain multiple media items.
  const fm = rm.forward_media;
  if (Array.isArray(fm)) {
    for (const item of fm) {
      if (!item) continue;
      const t = String(item.type || "").toLowerCase();
      if (t === "video") addTo(videoUrls, item.url);
      else if (t === "record" || t === "audio") addTo(recordUrls, item.url);
      else addTo(imageUrls, item.url);
      if (imageUrls.length + videoUrls.length + recordUrls.length >= 3) break;
    }
  }

  return {
    snippet,
    imageUrls: imageUrls.slice(0, 2),
    videoUrls: videoUrls.slice(0, 1),
    recordUrls: recordUrls.slice(0, 1),
    replyToBot: rm.sender_is_bot === true,
  };
}

export function noteRecentGroupImages(groupId, urls) {
  const gid = Number(groupId);
  if (!gid || !Array.isArray(urls) || urls.length === 0) return;
  recentGroupImages.set(gid, { t: nbot.now(), urls: urls.slice(0, 4) });
}

export function noteRecentUserImages(sessionKey, urls) {
  if (!sessionKey || !Array.isArray(urls) || urls.length === 0) return;
  recentUserImages.set(String(sessionKey), { t: nbot.now(), urls: urls.slice(0, 4) });
}

export function noteRecentGroupVideos(groupId, urls) {
  const gid = Number(groupId);
  if (!gid || !Array.isArray(urls) || urls.length === 0) return;
  recentGroupVideos.set(gid, { t: nbot.now(), urls: urls.slice(0, 2) });
}

export function noteRecentUserVideos(sessionKey, urls) {
  if (!sessionKey || !Array.isArray(urls) || urls.length === 0) return;
  recentUserVideos.set(String(sessionKey), { t: nbot.now(), urls: urls.slice(0, 2) });
}

export function noteRecentGroupRecords(groupId, urls) {
  const gid = Number(groupId);
  if (!gid || !Array.isArray(urls) || urls.length === 0) return;
  recentGroupRecords.set(gid, { t: nbot.now(), urls: urls.slice(0, 2) });
}

export function noteRecentUserRecords(sessionKey, urls) {
  if (!sessionKey || !Array.isArray(urls) || urls.length === 0) return;
  recentUserRecords.set(String(sessionKey), { t: nbot.now(), urls: urls.slice(0, 2) });
}

export function looksReferentialShortQuestion(text) {
  const t = stripAllCqSegments(String(text || "")).trim();
  if (!t) return false;
  if (t.length > 40) return false;
  return /(?:这个|那个|上面|刚才|这张|那张|啥|什么|哪个|哪款|哪套|什么意思|怎么弄|光影|这是啥|这是什么)/u.test(t);
}

export function buildRecentGroupSnippet(groupContext, limit = 15) {
  if (!groupContext || !Array.isArray(groupContext.history) || groupContext.history.length === 0) return "";
  const maxLines = Number.isFinite(limit) ? Math.max(3, Math.min(100, Math.floor(limit))) : 15;
  const selfId = groupContext.selfId !== undefined && groupContext.selfId !== null ? String(groupContext.selfId) : "";

  const lines = [];
  let selfLines = 0;
  const maxSelfLines = Math.min(4, Math.max(1, Math.floor(maxLines / 3)));
  const slice = groupContext.history.slice(0, maxLines).slice();
  const timed = slice.filter((m) => Number.isFinite(Number(m?.time))).length;
  if (timed >= Math.ceil(slice.length / 2)) {
    slice.sort((a, b) => Number(a?.time || 0) - Number(b?.time || 0));
  }
  const maxChars = 6000;
  for (const m of slice) {
    const sender = m?.sender || {};
    const senderId = sender?.user_id !== undefined && sender?.user_id !== null ? String(sender.user_id) : "";
    const isSelf = !!(selfId && senderId && senderId === selfId);
    // Keep a few bot messages to avoid redundant follow-ups (other plugins may already be handling the case),
    // but label them clearly and cap the count to avoid drowning out real user context.
    if (isSelf) {
      if (selfLines >= maxSelfLines) continue;
      selfLines += 1;
    }
    const name = isSelf
      ? "机器人"
      : String(sender.card || sender.nickname || "群友").replace(/\s+/g, " ").trim() || "群友";
    const content = sanitizeMessageForLlm(String(m?.raw_message || ""), null);
    if (!content) continue;
    const line = `${name}: ${content.slice(0, 120)}`;
    lines.push(line);
    if (lines.join("\n").length >= maxChars) break;
  }
  if (!lines.length) return "";
  return `【最近群聊片段】\n${lines.join("\n")}`.trim();
}

export function buildMultimodalImageMessage(imageUrls) {
  const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
  if (!urls.length) return null;
  return buildMultimodalAttachmentMessage(urls.slice(0, 2).map((url) => ({ kind: "image", url })));
}

export function buildMultimodalAttachmentMessage(attachments) {
  const items = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  if (!items.length) return null;

  const parts = [{ type: "text", text: "参考附件（仅用于理解当前问题，不要回复这句话）：" }];
  let added = 0;

  for (const item of items) {
    if (added >= 2) break; // keep in sync with backend inliner limit
    const url = typeof item === "string" ? String(item).trim() : String(item?.url || "").trim();
    if (!url) continue;

    const kindRaw = typeof item === "object" ? String(item?.kind || "").toLowerCase() : "";
    const kind =
      kindRaw === "video" || kindRaw === "record" || kindRaw === "audio" || kindRaw === "image" ? kindRaw : "file";
    const label =
      kind === "image"
        ? "图片"
        : kind === "video"
          ? "视频"
          : kind === "record" || kind === "audio"
            ? "语音/音频"
            : "附件";

    added += 1;
    parts.push({ type: "text", text: `附件 #${added}: ${label}` });
    parts.push({ type: "image_url", image_url: { url } });
  }

  if (!added) return null;
  return {
    role: "user",
    content: parts,
  };
}

export function getRelevantImageUrlsForSession(session, sessionKey) {
  const now = nbot.now();
  const fromSession =
    session &&
    Array.isArray(session.lastImageUrls) &&
    session.lastImageUrls.length > 0 &&
    now - Number(session.lastImageAt || 0) <= 2 * 60 * 1000
      ? session.lastImageUrls
      : [];
  if (fromSession.length) return fromSession;

  const fromUser = sessionKey ? recentUserImages.get(String(sessionKey)) : null;
  if (fromUser && Array.isArray(fromUser.urls) && fromUser.urls.length && now - Number(fromUser.t || 0) <= 2 * 60 * 1000) {
    return fromUser.urls;
  }

  const gid = session && session.groupId ? Number(session.groupId) : 0;
  const recent = gid ? recentGroupImages.get(gid) : null;
  if (recent && Array.isArray(recent.urls) && recent.urls.length && now - Number(recent.t || 0) <= 2 * 60 * 1000) {
    return recent.urls;
  }
  return [];
}

export function getRelevantVideoUrlsForSession(session, sessionKey) {
  const now = nbot.now();
  const fromSession =
    session &&
    Array.isArray(session.lastVideoUrls) &&
    session.lastVideoUrls.length > 0 &&
    now - Number(session.lastMediaAt || 0) <= 2 * 60 * 1000
      ? session.lastVideoUrls
      : [];
  if (fromSession.length) return fromSession;

  const fromUser = sessionKey ? recentUserVideos.get(String(sessionKey)) : null;
  if (fromUser && Array.isArray(fromUser.urls) && fromUser.urls.length && now - Number(fromUser.t || 0) <= 2 * 60 * 1000) {
    return fromUser.urls;
  }

  const gid = session && session.groupId ? Number(session.groupId) : 0;
  const recent = gid ? recentGroupVideos.get(gid) : null;
  if (recent && Array.isArray(recent.urls) && recent.urls.length && now - Number(recent.t || 0) <= 2 * 60 * 1000) {
    return recent.urls;
  }
  return [];
}

export function getRelevantRecordUrlsForSession(session, sessionKey) {
  const now = nbot.now();
  const fromSession =
    session &&
    Array.isArray(session.lastRecordUrls) &&
    session.lastRecordUrls.length > 0 &&
    now - Number(session.lastMediaAt || 0) <= 2 * 60 * 1000
      ? session.lastRecordUrls
      : [];
  if (fromSession.length) return fromSession;

  const fromUser = sessionKey ? recentUserRecords.get(String(sessionKey)) : null;
  if (fromUser && Array.isArray(fromUser.urls) && fromUser.urls.length && now - Number(fromUser.t || 0) <= 2 * 60 * 1000) {
    return fromUser.urls;
  }

  const gid = session && session.groupId ? Number(session.groupId) : 0;
  const recent = gid ? recentGroupRecords.get(gid) : null;
  if (recent && Array.isArray(recent.urls) && recent.urls.length && now - Number(recent.t || 0) <= 2 * 60 * 1000) {
    return recent.urls;
  }
  return [];
}
