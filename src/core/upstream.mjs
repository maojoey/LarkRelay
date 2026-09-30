// 上游通知拉取器：定时向内部「上游」服务拉一批待发通知，以**主人本人身份**
// （identity='owner'，用户身份不可用时 outbox 自带降级为机器人发）转发给指定收件人，
// 再把结果回执给上游。本服务保持零入站端口，这条线只出站 HTTPS 去拉，不开供上游推送的口子，
// 理由见 docs/DECISIONS.md「为何拉而不是被推」。
//
// 收件人只按「name」精确匹配，候选池只来自本应用自己拿到的数据——
// 主人的单聊对端 + 机器人所在群的成员，见 docs/DECISIONS.md「为何只按单聊/群成员精确同名解析」。
// open_id 按应用隔离，没有搜索权限，宁可不发也不发错人。
const DEFAULT_INTERVAL_SEC = 60;
const DEFAULT_GROUP_MEMBERS_TTL_SEC = 6 * 3600;
const GROUP_REFRESH_KEY = 'upstream_group_members_refreshed_at';

function normSpace(s) {
  return String(s ?? '').replace(/[\s　]+/g, '');
}

export function createUpstream({ db, api, outbox, userToken, config, log, health, fetchImpl = fetch }) {
  const cfg = config.upstream_notices;
  const enabled = !!cfg;
  const url = cfg?.url;
  const token = config.secrets?.upstream_token;
  const intervalSec = cfg?.interval_sec ?? DEFAULT_INTERVAL_SEC;
  const groupMembersTtlMs = (cfg?.group_members_ttl_sec ?? DEFAULT_GROUP_MEMBERS_TTL_SEC) * 1000;
  const ownerId = config.teacher_open_id ?? '';

  const kvKey = (id) => `upstream:${id}`;
  const userKvKey = (username) => `upstream_user:${username}`;

  // --- 收件人解析 -----------------------------------------------------

  function p2pCandidateIds() {
    return db.raw
      .prepare("SELECT DISTINCT peer_open_id AS open_id FROM chats WHERE chat_type = 'p2p' AND peer_open_id IS NOT NULL AND peer_open_id != ?")
      .all(ownerId)
      .map((r) => r.open_id);
  }

  function groupCandidateRows() {
    // 同一个人可能在多个群里，按 open_id 聚合成一行，不算重名。
    return db.raw
      .prepare(`
        SELECT gm.open_id AS open_id, COALESCE(MAX(NULLIF(gm.name, '')), MAX(c.name)) AS name
        FROM group_members gm
        LEFT JOIN contacts c ON c.open_id = gm.open_id
        WHERE gm.open_id != ?
        GROUP BY gm.open_id
      `)
      .all(ownerId);
  }

  function contactName(openId) {
    return db.raw.prepare('SELECT name FROM contacts WHERE open_id = ?').get(openId)?.name ?? null;
  }

  async function fetchNameFor(openId) {
    const asUser = userToken ? await userToken.getAccessToken().catch(() => undefined) : undefined;
    try {
      const info = await api.getUserByOpenId(openId, { asUser });
      if (info?.name) {
        db.upsertContact({ openId, name: info.name, role: 'unknown' });
        return info.name;
      }
    } catch (e) {
      log?.warn('补拉联系人姓名失败', { openId, err: e.message });
    }
    return null;
  }

  // 机器人所在的每个群，拉一遍成员名单整表替换（离群的人要真正从候选里消失）。
  // 6 小时一刷，0 命中时调用方会传 force 再刷一次。单个群读不了不该让整轮挂掉。
  async function refreshGroupMembers({ force = false } = {}) {
    const last = Number(db.getKv(GROUP_REFRESH_KEY) ?? 0);
    if (!force && Date.now() - last < groupMembersTtlMs) return;
    const groups = db.raw.prepare("SELECT chat_id FROM chats WHERE chat_type = 'group' AND bot_member = 1").all();
    for (const g of groups) {
      try {
        const members = await api.listChatMembers(g.chat_id);
        const rows = [];
        for (const m of members) {
          const openId = m.member_id ?? m.open_id;
          if (!openId || openId === ownerId) continue;
          const name = m.name || null;
          if (name) db.upsertContact({ openId, name, role: 'unknown' });
          rows.push({ openId, name });
        }
        db.replaceGroupMembers(g.chat_id, rows);
      } catch (e) {
        log?.warn('拉取群成员失败', { chatId: g.chat_id, err: e.message });
      }
    }
    db.setKv(GROUP_REFRESH_KEY, String(Date.now()));
  }

  async function buildCandidates() {
    const map = new Map(); // open_id -> name|null
    for (const id of p2pCandidateIds()) map.set(id, contactName(id));
    for (const row of groupCandidateRows()) {
      if (!map.has(row.open_id) || !map.get(row.open_id)) map.set(row.open_id, row.name ?? null);
    }
    for (const [openId, nm] of [...map]) {
      if (!nm) {
        const fetched = await fetchNameFor(openId);
        if (fetched) map.set(openId, fetched);
      }
    }
    return map;
  }

  function matchExact(candidates, name) {
    const target = normSpace(name);
    return [...candidates.entries()].filter(([, nm]) => nm && normSpace(nm) === target);
  }

  function stillKnown(openId) {
    return !!db.raw
      .prepare('SELECT 1 FROM contacts WHERE open_id = ? UNION SELECT 1 FROM chats WHERE peer_open_id = ? UNION SELECT 1 FROM group_members WHERE open_id = ?')
      .get(openId, openId, openId);
  }

  /** @returns {Promise<{openId: string} | {error: string}>} */
  // 缓存按上游账号名记（同名不同人时名字当键会串）；命中后仍要求联系人姓名与本次一致，改名/换人就重新解析
  async function resolveRecipient(name, username = null) {
    const cacheKey = userKvKey(username || name);
    const cached = db.getKv(cacheKey);
    if (cached && stillKnown(cached) && normSpace(contactName(cached)) === normSpace(name)) return { openId: cached };

    await refreshGroupMembers();
    let candidates = await buildCandidates();
    let hits = matchExact(candidates, name);

    if (hits.length === 0) {
      // 群成员名单可能刚变化（还没到 6 小时缓存期），0 命中时强制刷新一次再判。
      await refreshGroupMembers({ force: true });
      candidates = await buildCandidates();
      hits = matchExact(candidates, name);
    }

    if (hits.length === 0) return { error: `飞书里没找到「${name}」（私聊和所在群都没有）` };
    if (hits.length > 1) return { error: `飞书里有多个「${name}」，未自动发送` };
    const [openId] = hits[0];
    db.setKv(cacheKey, openId);
    return { openId };
  }

  // --- 拉取 / 入队 / 回执 -----------------------------------------------

  async function ackOne(id, body) {
    const res = await fetchImpl(`${url}/${id}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ack 失败：HTTP ${res.status}`);
    const j = await res.json();
    if (!j?.ok) throw new Error('ack 失败：上游返回 ok=false');
  }

  async function handleOne(notice) {
    const id = notice?.id;
    if (!id || typeof id !== 'string') {
      log?.warn('上游通知缺少合法 id，跳过', { notice });
      return { handed: false };
    }

    // 幂等：上一轮可能已经入队成功但 ack 失败，这轮只补 ack，不再重复入队。
    const cachedRelayId = db.getKv(kvKey(id));
    if (cachedRelayId) {
      await ackOne(id, { ok: true, relayId: Number(cachedRelayId) });
      return { handed: false };
    }

    const resolved = await resolveRecipient(notice.name, notice.username);
    if (resolved.error) {
      await ackOne(id, { ok: false, error: resolved.error });
      return { handed: false };
    }

    const relayId = outbox.queue({
      target: { type: 'open_id', id: resolved.openId },
      msgType: 'text',
      payload: { text: notice.text, fallback_prefix: '（代老师转达）' },
      purpose: 'upstream',
      identity: 'owner',
      uuid: id, // 上游的通知 id 直接当飞书发送的幂等键用
    });
    // 先写 kv 再 ack：ack 这一步失败，下一轮凭 kv 里已有的 relayId 直接重发 ack，不会重复入队。
    db.setKv(kvKey(id), String(relayId));
    await ackOne(id, { ok: true, relayId });
    return { handed: true };
  }

  async function once(now = Date.now()) {
    let notices;
    try {
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!j?.ok || !Array.isArray(j.notices)) throw new Error('响应形状不对');
      notices = j.notices;
    } catch (e) {
      log?.warn('拉取上游通知失败', { err: e.message });
      health?.set({ upstreamLastError: e.message, upstreamLastAt: now });
      return { error: e.message };
    }

    let handed = 0;
    for (const notice of notices) {
      try {
        const r = await handleOne(notice);
        if (r.handed) handed += 1;
      } catch (e) {
        // 单条处理失败（多半是 ack 网络失败）不该让整轮挂掉，下一轮会重试这一条。
        log?.error('处理上游通知失败', { id: notice?.id, err: e.message });
      }
    }

    if (handed > 0) {
      const s = health?.get() ?? {};
      health?.set({ upstreamHanded24h: (s.upstreamHanded24h ?? 0) + handed });
    }
    health?.set({ upstreamLastAt: now, upstreamLastError: null });
    return { total: notices.length, handed };
  }

  let running = false;
  async function safeOnce({ now = Date.now() } = {}) {
    if (!enabled) return { enabled: false };
    if (running) {
      log?.warn('上一轮上游通知拉取还没跑完，跳过本轮');
      return { skipped: true };
    }
    running = true;
    try {
      return await once(now);
    } catch (e) {
      log?.error('上游通知拉取异常', { err: e.message });
      health?.set({ upstreamLastError: e.message, upstreamLastAt: now });
      return { error: e.message };
    } finally {
      running = false;
    }
  }

  let timer = null;
  function start(everyMs = intervalSec * 1000) {
    if (!enabled) return;
    stop();
    timer = setInterval(() => { safeOnce().catch(() => {}); }, everyMs);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { enabled, once, safeOnce, start, stop, resolveRecipient };
}
