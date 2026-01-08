import { replyBatches, pendingReplySessions, sessions } from "../state.js";
import { callReplyModel } from "./reply.js";

function getOrCreateBatch(sessionKey) {
  const key = String(sessionKey || "");
  if (!key) return null;
  const now = nbot.now();
  let batch = replyBatches.get(key);
  if (!batch) {
    batch = { firstAt: now, lastAt: now };
    replyBatches.set(key, batch);
  }
  return batch;
}

export function scheduleReplyFlush(sessionKey, config) {
  const key = String(sessionKey || "");
  if (!key) return;
  const session = sessions.get(key);
  if (!session || session.state !== "active") return;

  const batch = getOrCreateBatch(key);
  if (!batch) return;
  const now = nbot.now();
  batch.lastAt = now;
  if (!batch.firstAt) batch.firstAt = now;

  // If reply merge is disabled, flush immediately (still respects pendingReplySessions).
  const idleMs = Number(config?.replyMergeIdleMs ?? 0);
  if (Number.isFinite(idleMs) && idleMs <= 0) {
    flushReplyBatch(key, config);
  }
}

export function flushReplyBatch(sessionKey, config) {
  const key = String(sessionKey || "");
  if (!key) return;

  const session = sessions.get(key);
  if (!session || session.state !== "active") {
    replyBatches.delete(key);
    return;
  }
  if (pendingReplySessions.has(key)) {
    return;
  }

  replyBatches.delete(key);
  callReplyModel(session, key, config, false);
}

export function flushDueReplyBatches(config) {
  const now = nbot.now();
  const idleMs = Number(config?.replyMergeIdleMs ?? 0);
  const maxMs = Number(config?.replyMergeMaxMs ?? 0);

  for (const [sessionKey, batch] of replyBatches.entries()) {
    if (!batch) {
      replyBatches.delete(sessionKey);
      continue;
    }
    const session = sessions.get(sessionKey);
    if (!session || session.state !== "active") {
      replyBatches.delete(sessionKey);
      continue;
    }
    if (pendingReplySessions.has(sessionKey)) {
      continue;
    }
    const firstAt = Number(batch.firstAt || 0);
    const lastAt = Number(batch.lastAt || 0);
    if (!firstAt || !lastAt) {
      replyBatches.delete(sessionKey);
      continue;
    }

    const dueByIdle = Number.isFinite(idleMs) && idleMs > 0 ? now - lastAt >= idleMs : true;
    const dueByWindow = Number.isFinite(maxMs) && maxMs > 0 ? now - firstAt >= maxMs : false;
    if (!dueByIdle && !dueByWindow) continue;

    flushReplyBatch(sessionKey, config);
  }
}

