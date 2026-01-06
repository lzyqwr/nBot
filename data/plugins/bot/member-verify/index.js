// 新成员验证插件
// 当新成员进群时，要求在指定时间内发言，否则自动踢出

const { log, storage, callApi, sendMessage, fetchGroupMemberList, getConfig, now, at } = globalThis.nbot;

// 待验证成员存储 key
const PENDING_KEY = "pending_members";
const BOT_NAME_KEY = "bot_name_by_group";

let selfId = null;
const pendingNameRequests = new Map();
let warnedAdminCheck = false;
const adminCache = new Map(); // groupId -> { isAdmin: boolean, checkedAt: number }

let lastCleanupAt = 0;

// 获取待验证成员列表
function getPendingMembers() {
  return storage.get(PENDING_KEY) || {};
}

// 保存待验证成员列表
function savePendingMembers(pending) {
  storage.set(PENDING_KEY, pending);
}

function getBotNames() {
  return storage.get(BOT_NAME_KEY) || {};
}

function saveBotNames(map) {
  storage.set(BOT_NAME_KEY, map);
}

function resolveMemberDisplayName(member) {
  if (!member || typeof member !== "object") return null;
  const card = String(member.card || "").trim();
  if (card) return card;
  const nickname = String(member.nickname || "").trim();
  if (nickname) return nickname;
  const name = String(member.name || "").trim();
  if (name) return name;
  return null;
}

function safeUserLabel(userId, nickname) {
  const name = String(nickname || "").trim();
  if (name) return name;
  // Avoid leaking QQ number. Use @ mention placeholder (will be sanitized server-side).
  return at ? at(userId) : "成员";
}

// 生成随机超时时间（秒）
function randomTimeout(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 格式化消息模板
function formatMessage(template, replacements) {
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

function cleanupIntervalMs(config) {
  const secs = Number(config.cleanup_interval_seconds ?? 5);
  const safeSecs = Number.isFinite(secs) ? Math.max(1, Math.min(60, Math.floor(secs))) : 5;
  return safeSecs * 1000;
}

// 检查并踢出超时的成员（仅处理指定群；由 interval 节流触发）
function checkAndKickExpiredGroup(groupId, config) {
  const pending = getPendingMembers();
  const groupKey = String(groupId);
  const users = pending[groupKey];
  if (!users || typeof users !== "object") return;

  const currentTime = now();
  const expired = [];
  let changed = false;

  const remainingUsers = {};
  for (const [userId, data] of Object.entries(users || {})) {
    if (currentTime >= data.expireTime) {
      expired.push({ groupId: groupKey, userId, nickname: data.nickname });
      changed = true;
    } else {
      remainingUsers[userId] = data;
    }
  }

  if (Object.keys(remainingUsers).length > 0) {
    pending[groupKey] = remainingUsers;
  } else {
    delete pending[groupKey];
    changed = true;
  }

  if (changed) {
    savePendingMembers(pending);
  }

  for (const { groupId, userId, nickname } of expired) {
    try {
      callApi("set_group_kick", {
        group_id: Number(groupId),
        user_id: Number(userId),
        reject_add_request: config.kick_reject_reapply || false,
      });

      const botNames = getBotNames();
      const operatorName = String(botNames[String(groupId)] || "").trim() || "管理员";

      const kickMsg = formatMessage(
        config.kick_message || "{operator} 将 {user} 移出群聊：未在规定时间内完成验证。",
        {
          operator: operatorName,
          user: safeUserLabel(userId, nickname),
        },
      );
      sendMessage(groupId, kickMsg);
    } catch (e) {
      log.error(`[member-verify] 踢出成员失败: ${e}`);
    }
  }
}

function updateAdminCache(groupId, isAdmin) {
  const gid = Number(groupId);
  if (!Number.isFinite(gid) || gid <= 0) return;
  adminCache.set(String(gid), { isAdmin: !!isAdmin, checkedAt: now() });
}

// 检查机器人是否是管理员（从后端传入的 ctx.bot_is_admin / 缓存读取；插件运行时无法同步 await callApi 拿到响应）
async function isBotAdmin(groupId) {
  const gid = Number(groupId);
  if (!Number.isFinite(gid) || gid <= 0) return false;
  const cacheKey = String(gid);
  const cached = adminCache.get(cacheKey);
  const ts = now();
  if (cached && typeof cached.checkedAt === "number" && ts - cached.checkedAt < 60_000) {
    return !!cached.isAdmin;
  }
  // Unknown: treat as not admin (will be updated by onNotice when backend provides bot_is_admin).
  return false;
}

return {
  onEnable() {
    log.info("[member-verify] 新成员验证插件已启用");
    // 清理可能残留的过期数据
    const pending = getPendingMembers();
    const currentTime = now();
    let changed = false;

    for (const groupId of Object.keys(pending)) {
      for (const userId of Object.keys(pending[groupId])) {
        if (currentTime >= pending[groupId][userId].expireTime) {
          delete pending[groupId][userId];
          changed = true;
        }
      }
      if (Object.keys(pending[groupId]).length === 0) {
        delete pending[groupId];
        changed = true;
      }
    }

    if (changed) {
      savePendingMembers(pending);
    }
  },

  onDisable() {
    log.info("[member-verify] 新成员验证插件已禁用");
  },

  // Heartbeat-driven cleanup (JS runtime has no timers). This runs even when the group is quiet.
  async onMetaEvent(ctx) {
    try {
      if (!ctx || ctx.meta_event_type !== "heartbeat") return true;
      const config = getConfig();
      const intervalMs = cleanupIntervalMs(config);
      const currentTime = now();
      if (currentTime - lastCleanupAt < intervalMs) return true;
      lastCleanupAt = currentTime;

      const pending = getPendingMembers();
      for (const gid of Object.keys(pending || {})) {
        if (!gid) continue;
        if (config.require_admin) {
          const ok = await isBotAdmin(gid);
          if (!ok) continue;
        }
        checkAndKickExpiredGroup(gid, config);
      }
    } catch (e) {
      log.warn(`[member-verify] onMetaEvent error: ${e}`);
    }
    return true;
  },

  // 处理通知事件（新成员进群）
  async onNotice(ctx) {
    const config = getConfig();

    if (ctx && ctx.self_id && selfId === null) {
      const v = String(ctx.self_id).trim();
      selfId = v ? v : null;
    }

    if (config.require_admin && !warnedAdminCheck) {
      warnedAdminCheck = true;
      log.info("[member-verify] 已启用 require_admin：仅当机器人为群管理员/群主时才会触发验证");
    }

    // Update admin cache from backend-provided context when available.
    if (ctx && ctx.group_id) {
      if (typeof ctx.bot_is_admin === "boolean") {
        updateAdminCache(ctx.group_id, ctx.bot_is_admin);
      } else if (config.require_admin && !warnedAdminCheck) {
        warnedAdminCheck = true;
        log.warn("[member-verify] 后端未提供 bot_is_admin，require_admin 将视为非管理员并跳过（请更新后端）");
      }
    }

    // Best-effort cleanup for this group to improve timeout handling (interval throttled)
    const intervalMs = cleanupIntervalMs(config);
    const currentTime = now();
    if (currentTime - lastCleanupAt >= intervalMs) {
      lastCleanupAt = currentTime;
      if (ctx.group_id) {
        checkAndKickExpiredGroup(ctx.group_id, config);
      }
    }

    // 只处理群成员增加事件
    if (ctx.notice_type !== "group_increase") {
      return true;
    }

    const { user_id: userId, group_id: groupId, sub_type: subType } = ctx;

    // 检查是否需要管理员权限
    if (config.require_admin) {
      const isAdmin = typeof ctx.bot_is_admin === "boolean"
        ? !!ctx.bot_is_admin
        : await isBotAdmin(groupId);
      if (!isAdmin) {
        log.warn(`[member-verify] 机器人不是群 ${groupId} 的管理员，跳过验证`);
        return true;
      }
    }

    // 生成随机超时时间
    const minTimeout = config.min_timeout || 30;
    const maxTimeout = config.max_timeout || 90;
    const timeout = randomTimeout(minTimeout, maxTimeout);
    const expireTime = now() + timeout * 1000;

    // 记录待验证成员
    const pending = getPendingMembers();
    const groupKey = String(groupId);

    if (!pending[groupKey]) {
      pending[groupKey] = {};
    }

    pending[groupKey][String(userId)] = {
      joinTime: now(),
      expireTime: expireTime,
      timeout: timeout,
      nickname: ""
    };

    savePendingMembers(pending);

    // Best-effort: fetch member list once to resolve nicknames (no QQ number in outputs).
    // Results delivered via onGroupInfoResponse.
    if (groupId) {
      const requestId = `member-verify-names-${groupKey}-${String(userId)}-${now()}`;
      pendingNameRequests.set(requestId, { groupId: groupKey, userId: String(userId) });
      fetchGroupMemberList(requestId, groupId);
    }

    // 发送欢迎消息
    const welcomeMsg = formatMessage(config.welcome_message || "{user} 欢迎加入本群！请在 {timeout} 秒内发送任意消息完成验证，否则将被移出群聊。", {
      user: safeUserLabel(userId, ""),
      timeout: String(timeout)
    });

    sendMessage(groupId, welcomeMsg);

    return true;
  },

  // 处理消息事件（检查是否是待验证成员发言）
  async preMessage(ctx) {
    const config = getConfig();
    const { user_id: userId, group_id: groupId } = ctx;

    // Best-effort cleanup for this group (interval throttled)
    const intervalMs = cleanupIntervalMs(config);
    const currentTime = now();
    if (currentTime - lastCleanupAt >= intervalMs) {
      lastCleanupAt = currentTime;
      if (groupId) {
        checkAndKickExpiredGroup(groupId, config);
      }
    }

    // 只处理群消息
    if (!groupId) {
      return true;
    }

    // 检查发言者是否是待验证成员
    const pending = getPendingMembers();
    const groupKey = String(groupId);
    const userKey = String(userId);

    if (pending[groupKey] && pending[groupKey][userKey]) {
      const nickname = pending[groupKey][userKey].nickname;
      // 验证成功，移除待验证状态
      delete pending[groupKey][userKey];

      if (Object.keys(pending[groupKey]).length === 0) {
        delete pending[groupKey];
      }

      savePendingMembers(pending);

      // 发送验证成功消息
      const successMsg = config.verify_success_message;
      if (successMsg) {
        const formattedMsg = formatMessage(successMsg, {
          user: safeUserLabel(userId, nickname)
        });
        sendMessage(groupId, formattedMsg);
      }
    }

    return true;
  }

  ,async onGroupInfoResponse(resp) {
    try {
      if (!resp || resp.success !== true) return true;
      if (resp.infoType !== "group_member_list") return true;

      const requestId = String(resp.requestId || "");
      const req = pendingNameRequests.get(requestId);
      if (!req) return true;
      pendingNameRequests.delete(requestId);

      const members = Array.isArray(resp.data) ? resp.data : [];
      const pending = getPendingMembers();
      const groupKey = String(req.groupId);
      const userKey = String(req.userId);

      const me = selfId ? members.find((m) => String(m.user_id) === String(selfId)) : null;
      const meName = resolveMemberDisplayName(me);
      if (meName) {
        const botNames = getBotNames();
        botNames[groupKey] = meName;
        saveBotNames(botNames);
      }

      const target = members.find((m) => String(m.user_id) === userKey);
      const name = resolveMemberDisplayName(target);
      if (name && pending[groupKey] && pending[groupKey][userKey]) {
        pending[groupKey][userKey].nickname = name;
        savePendingMembers(pending);
      }
    } catch (e) {
      log.warn(`[member-verify] onGroupInfoResponse error: ${e}`);
    }
    return true;
  }
};
