// 归档器：以**用户身份**定时拉「机器人看不到的那一半」。
//
// 为什么非要这条线：机器人只看得到别人发给**它**的消息。别人私聊你本人的内容，
// 任何机器人都读不到——这是所有 IM 的规则，不是飞书的限制。想让归档覆盖
// 「所有发给我的消息」，只能用你本人授权的身份去读自己的会话。
//
// 会话怎么来，两条路，按可用性自动降级：
//   A. 直接列：listMyChats(types='p2p,group')。官方文档说列表不含单聊，但官方 CLI 实测会传这个参数。
//      能用就用，覆盖最全。
//   B. 列不出来就按联系人逐个解析：拿 contacts 表里的人去批量换单聊 chat_id。
//      代价是只能覆盖「已知的人」，好处是不依赖那个没文档的参数。
import { createPull } from '../core/pull.mjs';

const DISCOVER_KEY = 'archiver_discovery_mode';

export function createArchiver({ db, api, userToken, config, log, health, handleEvent, isExcluded }) {
  const pull = createPull({ db, api, log, handleEvent, isExcluded });
  const overlapMs = (config.reconcile?.overlap_sec ?? 600) * 1000;
  // 首次见到一个会话时回溯多久。默认 30 天：够把「上线前就存在的对话」收进来，
  // 又不至于一上来就把几年的历史全拉一遍（单会话分页上限 20×50=1000 条）。
  const backfillMs = (config.archive?.backfill_days ?? 30) * 86_400_000;
  const ownerId = config.teacher_open_id;

  /** 把发现到的会话登记进 chats 表，之后由 pullChat 按游标拉。 */
  function remember(chatId, chatType, peerOpenId, lastMsgAt, name) {
    db.upsertChat({ chatId, chatType, peerOpenId: peerOpenId ?? null, lastMsgAt: lastMsgAt ?? null, name: name ?? null });
  }

  /** 路线 A：直接列自己的会话。失败或列不出单聊都返回 null，交给调用方降级。 */
  async function discoverByList(asUser) {
    let chats;
    try {
      chats = await api.listMyChats({ types: 'p2p,group', asUser });
    } catch (e) {
      log?.warn('列会话失败，降级为按联系人解析', { err: e.message });
      return null;
    }
    const p2p = chats.filter((c) => c.chat_mode === 'p2p');
    if (p2p.length === 0) {
      // 群能列出来但单聊一个都没有 → 多半是那个没文档的 types 参数不生效
      log?.warn('会话列表里没有单聊，降级为按联系人解析', { total: chats.length });
      return null;
    }
    for (const c of chats) {
      remember(c.chat_id, c.chat_mode === 'p2p' ? 'p2p' : 'group', c.p2p_target_id ?? null, null, c.name ?? null);
    }
    return chats.map((c) => ({ chatId: c.chat_id, chatType: c.chat_mode === 'p2p' ? 'p2p' : 'group' }));
  }

  /** 路线 B：拿已知联系人批量换单聊 chat_id。本人自己那条排除掉。 */
  async function discoverByContacts(asUser) {
    const ids = db.raw
      .prepare('SELECT open_id FROM contacts WHERE open_id != ?')
      .all(ownerId ?? '')
      .map((r) => r.open_id);
    if (ids.length === 0) return [];
    const map = await api.resolveP2pChats(ids, { asUser });
    const out = [];
    for (const [openId, chatId] of Object.entries(map)) {
      remember(chatId, 'p2p', openId);
      out.push({ chatId, chatType: 'p2p' });
    }
    return out;
  }

  async function discover(asUser) {
    const remembered = db.getKv(DISCOVER_KEY);
    if (remembered !== 'contacts') {
      const byList = await discoverByList(asUser);
      if (byList) { db.setKv(DISCOVER_KEY, 'list'); return byList; }
      // 记下来，别每轮都白试一次
      db.setKv(DISCOVER_KEY, 'contacts');
    }
    return discoverByContacts(asUser);
  }

  async function once({ now = Date.now() } = {}) {
    const asUser = await userToken.getAccessToken();
    const chats = await discover(asUser);
    let missed = 0; let scanned = 0; let failed = 0;

    for (const c of chats) {
      try {
        const r = await pull.pullChat({
          chatId: c.chatId, chatType: c.chatType, asUser, now, overlapMs, backfillMs, transport: 'poll',
        });
        missed += r.missed; scanned += r.scanned;
      } catch (e) {
        // 单个会话读不了不该让整轮失败——可能只是那个会话被删了或没权限
        failed += 1;
        log?.warn('归档单个会话失败', { chatId: c.chatId, err: e.message });
      }
    }

    health?.set({ archiveLastAt: now, archiveChats: chats.length, archiveFailed: failed, archiveFailStreak: 0, archiveLastError: null });
    if (missed > 0) log?.info('归档补录', { missed, scanned, chats: chats.length });
    return { chats: chats.length, scanned, missed, failed, mode: db.getKv(DISCOVER_KEY) };
  }

  async function safeOnce() {
    try {
      return await once();
    } catch (e) {
      const streak = (health?.get()?.archiveFailStreak ?? 0) + 1;
      health?.set({ archiveFailStreak: streak, archiveLastError: e.message });
      log?.error('归档失败', { streak, err: e.message });
      return { error: e.message, streak };
    }
  }

  let timer = null;
  function start(everyMs) {
    stop();
    timer = setInterval(() => { safeOnce().catch(() => {}); }, everyMs);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { once, safeOnce, start, stop, discover };
}
