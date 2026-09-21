// 对账轮询：这一层专门抓「连着但收不到」。
//
// 长连接没有 webhook 那样的重投保证，断线期间的事件是**直接丢**的；
// 而且如果有人对同一应用开了第二个消费者，事件会被分流走一半，表现是偶尔丢消息、连接状态一切正常。
// 两种都只有端到端比对能发现：拉一遍飞书那边的消息列表，跟库里对。
import { createPull } from '../core/pull.mjs';


export function createReconcile({ db, api, config, log, health, handleEvent }) {
  const pull = createPull({ db, api, log, handleEvent });
  // 首次见到会话同样回溯（理由同 archiver）：服务刚上线时机器人所在的群也该收进历史
  const backfillMs = (config.archive?.backfill_days ?? 30) * 86_400_000;
  const overlapMs = (config.reconcile?.overlap_sec ?? 600) * 1000;

  // 机器人自己的会话列表就是「它读得了哪些」的权威来源，比我们自己推断可靠
  async function refreshBotChats() {
    try {
      for (const c of await api.listMyChats({ types: 'group,p2p' })) {
        db.upsertChat({
          chatId: c.chat_id,
          chatType: c.chat_mode === 'p2p' ? 'p2p' : 'group',
          peerOpenId: c.p2p_target_id ?? null,
          botMember: 1,
        });
      }
    } catch (e) {
      // 列不出来不影响这一轮：已知的那些照拉
      log?.warn('刷新机器人会话列表失败', { err: e.message });
    }
  }

  async function once({ now = Date.now() } = {}) {
    // **只拉机器人自己在的会话。** 会话表是两条线共用的，里面还有用户身份枚举出来的、
    // 机器人根本进不去的单聊——拿机器人身份去拉那些必然 400，而且会连续失败。
    // 每轮先按机器人自己的会话列表刷新一次归属，新进的群立刻纳入、退出的自动淡出。
    await refreshBotChats();
    const chats = db.listBotChats();
    let missed = 0;
    let scanned = 0;

    // 拉取那一步与用户身份归档线共用同一份实现（core/pull.mjs），免得两边的去重口径、
    // 游标推进、出站记账慢慢漂移——那种不一致最难查。
    for (const chat of chats) {
      const r = await pull.pullChat({
        chatId: chat.chat_id, chatType: chat.chat_type, now, overlapMs, backfillMs, transport: 'poll',
      });
      scanned += r.scanned;
      missed += r.missed;
    }

    const s = health.get();
    // ws 一直是 connected 却仍漏了用户消息 → 多半有第二个消费者在抢事件
    const splitSuspect = missed > 0 && s.wsState === 'connected';
    health.set({ lastPollAt: now, pollFailStreak: 0, pollLastError: null, splitSuspect: splitSuspect || s.splitSuspect });
    health.addMissed(missed);
    if (missed > 0) {
      log.warn('对账补录了漏掉的消息', { missed, scanned, splitSuspect });
    }
    return { missed, scanned, splitSuspect };
  }

  async function safeOnce() {
    try {
      return await once();
    } catch (e) {
      const streak = health.get().pollFailStreak + 1;
      health.set({ pollFailStreak: streak, pollLastError: e.message });
      log.error('对账失败', { streak, err: e.message });
      return { error: e.message, streak };
    }
  }

  return { once, safeOnce };
}
