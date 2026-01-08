// Shared module-level state for smart-assist (singleton per plugin runtime).

// Session state Map<sessionKey, Session>
export const sessions = new Map();

// Cooldown records Map<sessionKey, lastCleanupTime>
export const cooldowns = new Map();

// Pending LLM requests Map<requestId, RequestInfo>
export const pendingRequests = new Map();

// Pending group info requests Map<requestId, RequestInfo>
export const pendingGroupInfoRequests = new Map();

// Sessions with pending decision/context requests (avoid spamming)
export const pendingDecisionSessions = new Set();
export const pendingContextSessions = new Set();
export const pendingReplySessions = new Set();

// Decision batching (reduce LLM calls while still judging every message)
export const decisionBatches = new Map(); // Map<sessionKey, { userId:number, groupId:number, items: {...}[] }>
export const DECISION_BATCH_MAX_ITEMS = 8;

// Recent media (help the model resolve "the image above")
export const recentGroupImages = new Map(); // Map<groupId, { t:number, urls:string[] }>
export const recentUserImages = new Map(); // Map<sessionKey, { t:number, urls:string[] }>
export const recentGroupVideos = new Map(); // Map<groupId, { t:number, urls:string[] }>
export const recentUserVideos = new Map(); // Map<sessionKey, { t:number, urls:string[] }>
export const recentGroupRecords = new Map(); // Map<groupId, { t:number, urls:string[] }>
export const recentUserRecords = new Map(); // Map<sessionKey, { t:number, urls:string[] }>

let requestIdCounter = 0;

export function genRequestId(type) {
  requestIdCounter += 1;
  return `smart-assist-${type}-${requestIdCounter}-${nbot.now()}`;
}

export function resetAllState() {
  sessions.clear();
  cooldowns.clear();
  pendingRequests.clear();
  pendingGroupInfoRequests.clear();
  pendingDecisionSessions.clear();
  pendingContextSessions.clear();
  pendingReplySessions.clear();
  decisionBatches.clear();
  recentGroupImages.clear();
  recentUserImages.clear();
  recentGroupVideos.clear();
  recentUserVideos.clear();
  recentGroupRecords.clear();
  recentUserRecords.clear();
  requestIdCounter = 0;
}

