import { callDecisionModel } from "./decision/decision_model.js";
import {
  pendingContextSessions,
  pendingDecisionSessions,
  pendingGroupInfoRequests,
  pendingReplySessions,
  pendingRequests,
  sessions,
} from "./state.js";
import { endSession } from "./session.js";

export function cleanupStaleRequests(config) {
  const now = nbot.now();

  // LLM requests
  for (const [requestId, info] of pendingRequests.entries()) {
    const createdAt = info?.createdAt || 0;
    if (!createdAt || now - createdAt <= config.requestTimeoutMs) continue;

    pendingRequests.delete(requestId);

    const sessionKey = info?.sessionKey;
    if (info?.type === "decision") {
      pendingDecisionSessions.delete(sessionKey);
    } else if (info?.type === "reply") {
      pendingReplySessions.delete(sessionKey);
      const session = sessions.get(sessionKey);
      if (session && session.state === "active") {
        const shouldNotify = !!session.startedByMention || !!session.forceMentionNextReply;
        if (shouldNotify) {
          const at = session.groupId ? nbot.at(session.userId) : "";
          const prefix = at ? `${at} ` : "";
          nbot.sendReply(session.userId, session.groupId || 0, `${prefix}回复超时了，再发一次关键信息？`);
          session.forceMentionNextReply = false;
          session.lastMentionAt = nbot.now();
          session.lastBotReplyAt = nbot.now();
        } else {
          // Auto-triggered sessions: don't spam on timeouts.
          endSession(sessionKey);
        }
      }
    }

    nbot.log.warn(`Request timeout: ${info?.type || "unknown"} ${requestId}`);
  }

  // Group context requests
  for (const [requestId, info] of pendingGroupInfoRequests.entries()) {
    const createdAt = info?.createdAt || 0;
    if (!createdAt || now - createdAt <= config.contextTimeoutMs) continue;

    pendingGroupInfoRequests.delete(requestId);

    const sessionKey = info?.sessionKey;
    pendingContextSessions.delete(sessionKey);

    // Fallback: proceed without context so user won't get stuck.
    if (info?.type === "context") {
      callDecisionModel(
        sessionKey,
        info.userId,
        info.groupId,
        info.message,
        info.mentioned,
        info.items,
        config,
        null
      );
    }

    nbot.log.warn(`Context timeout: ${requestId}`);
  }
}
