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

  async function once({ now = Date.now() } = {}) {
    const chats = db.listPollableChats();
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
    health.set({ lastPollAt: now, pollFailStreak: 0, splitSuspect: splitSuspect || s.splitSuspect });
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
      health.set({ pollFailStreak: streak });
      log.error('对账失败', { streak, err: e.message });
      return { error: e.message, streak };
    }
  }

  return { once, safeOnce };
}
