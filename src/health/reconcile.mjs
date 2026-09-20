// 对账轮询：这一层专门抓「连着但收不到」。
//
// 长连接没有 webhook 那样的重投保证，断线期间的事件是**直接丢**的；
// 而且如果有人对同一应用开了第二个消费者，事件会被分流走一半，表现是偶尔丢消息、连接状态一切正常。
// 两种都只有端到端比对能发现：拉一遍飞书那边的消息列表，跟库里对。
import { normalize } from '../lark/normalize.mjs';

const CURSOR_KEY = (chatId) => `poll_cursor:${chatId}`;

export function createReconcile({ db, api, config, log, health, handleEvent }) {
  const overlapMs = (config.reconcile?.overlap_sec ?? 600) * 1000;

  async function once({ now = Date.now() } = {}) {
    const chats = db.listPollableChats();
    let missed = 0;
    let scanned = 0;

    for (const chat of chats) {
      const saved = Number(db.getKv(CURSOR_KEY(chat.chat_id)) ?? 0);
      // 窗口刻意重叠：飞书的 create_time 与我们收到的时刻不完全对齐，卡死边界会漏掉临界那条
      const start = saved > 0 ? saved - overlapMs : now - overlapMs;
      const items = await api.listMessages(chat.chat_id, start, now);
      scanned += items.length;

      for (const item of items) {
        if (item.deleted) continue;
        const msg = normalize(item, 'poll', { chatType: chat.chat_type });
        if (db.getMessage(msg.message_id)) continue;

        if (msg.sender_type === 'user') {
          // 真漏了：走同一个入口补录，行为与 ws 完全一致
          handleEvent(msg);
          missed += 1;
        } else {
          // 机器人发的但库里没有——本机 lark-cli 以同一身份发的消息会走到这里，记账不处理
          db.insertOutbound({ ...msg, status: 'done' });
        }
      }
      db.setKv(CURSOR_KEY(chat.chat_id), String(now));
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
