import { fetchGroupContext, callDecisionModel } from "./decision_model.js";
import {
  DECISION_BATCH_MAX_ITEMS,
  decisionBatches,
  pendingContextSessions,
  pendingDecisionSessions,
} from "../state.js";

function buildDecisionPayload(sessionKey) {
  const batch = decisionBatches.get(sessionKey);
  if (!batch || !batch.items.length) return null;

  const items = batch.items.splice(0, DECISION_BATCH_MAX_ITEMS);
  const mentionedAny = items.some((x) => !!x?.mentioned);

  const merged = items
    .map((x, idx) => {
      const base = String(x?.text || "").trim();
      const flag = x?.isReply ? (x?.replyToBot ? "[回复机器人] " : "[回复他人] ") : "";
      const reply = x?.replySnippet ? `（回复内容：${String(x.replySnippet).trim()}） ` : "";
      return `${idx + 1}. ${flag}${reply}${base}`.trim();
    })
    .filter(Boolean)
    .join("\n");

  return {
    userId: batch.userId,
    groupId: batch.groupId,
    selfId: batch.selfId || "",
    mentioned: mentionedAny,
    merged,
    items,
  };
}

function restoreDecisionPayload(sessionKey, payload) {
  if (!payload) return;
  let batch = decisionBatches.get(sessionKey);
  if (!batch) {
    batch = {
      userId: payload.userId,
      groupId: payload.groupId,
      selfId: payload.selfId || "",
      items: [],
    };
    decisionBatches.set(sessionKey, batch);
  }
  batch.userId = payload.userId;
  batch.groupId = payload.groupId;
  batch.selfId = payload.selfId || batch.selfId || "";
  if (Array.isArray(payload.items) && payload.items.length) {
    batch.items = [...payload.items, ...batch.items];
  }
}

export function scheduleDecisionFlush(sessionKey, urgent, config) {
  if (urgent) {
    flushDecisionBatch(sessionKey, config);
    return;
  }
  // No JS timers in plugin runtime; real 5s merge is driven by backend tick -> onMetaEvent.
  // Fallback: if the batch grows too large, flush immediately to avoid unbounded memory.
  const batch = decisionBatches.get(sessionKey);
  if (batch && Array.isArray(batch.items) && batch.items.length >= DECISION_BATCH_MAX_ITEMS) {
    flushDecisionBatch(sessionKey, config);
  }
}

export function flushDecisionBatch(sessionKey, config) {
  const payload = buildDecisionPayload(sessionKey);
  if (!payload) return;

  if (pendingDecisionSessions.has(sessionKey) || pendingContextSessions.has(sessionKey)) {
    restoreDecisionPayload(sessionKey, payload);
    return;
  }

  if (config.fetchGroupContext) {
    pendingContextSessions.add(sessionKey);
    fetchGroupContext(
      sessionKey,
      payload.userId,
      payload.groupId,
      payload.merged,
      payload.mentioned,
      payload.items,
      config,
      payload.selfId
    );
  } else {
    callDecisionModel(
      sessionKey,
      payload.userId,
      payload.groupId,
      payload.merged,
      payload.mentioned,
      payload.items,
      config,
      null
    );
  }
}

export function flushDueDecisionBatches(config) {
  const now = nbot.now();
  for (const [sessionKey, batch] of decisionBatches.entries()) {
    if (!batch || !Array.isArray(batch.items) || batch.items.length === 0) continue;
    if (pendingDecisionSessions.has(sessionKey) || pendingContextSessions.has(sessionKey)) {
      continue;
    }
    const firstAt = Number(batch.items[0]?.t || 0);
    const lastAt = Number(batch.items[batch.items.length - 1]?.t || 0);
    if (!firstAt || !lastAt) continue;
    const windowMs = config.decisionMergeIdleMs;
    const dueByIdle = now - lastAt >= windowMs;
    const dueByWindow = now - firstAt >= windowMs;
    if (!dueByIdle && !dueByWindow) continue;
    flushDecisionBatch(sessionKey, config);
  }
}
