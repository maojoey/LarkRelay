// 「把一个会话的历史按游标拉进库」——对账和归档共用的那一步。
//
// 抽出来不是为了少写几行，是为了**不让两边漂移**：去重口径、游标推进、
// 机器人自己发的消息怎么记账，这三件事一旦两边不一致，就会出现
// 「同一条消息在一条线上是新的、在另一条线上是旧的」这种最难查的账。
import { normalize } from '../lark/normalize.mjs';

export const cursorKey = (chatId) => `poll_cursor:${chatId}`;

export function createPull({ db, api, log, handleEvent, isExcluded }) {
  /**
   * 拉一个会话在 [since-overlap, now] 窗口内的消息。
   * 窗口刻意重叠：飞书的 create_time 与我们收到的时刻不完全对齐，卡死边界会漏掉临界那条。
   * @returns {{ scanned:number, missed:number }} missed = 真正补录进来的**用户**消息条数
   */
  async function pullChat({
    chatId, chatType = 'p2p', asUser, now = Date.now(),
    overlapMs = 600_000, backfillMs, transport = 'poll',
  }) {
    // 排除的会话直接不拉：也不推游标——将来撤销排除时才能把这段历史补回来
    if (isExcluded?.(chatId)) return { scanned: 0, missed: 0, skipped: true };

    const saved = Number(db.getKv(cursorKey(chatId)) ?? 0);
    // **首次见到这个会话时要回溯一段历史，不能只拉重叠窗口。**
    // overlap 是为「补断线漏掉的那几条」设计的（十分钟量级）；
    // 拿它当首次归档的起点，结果就是刚上线时只收进最近十分钟，历史全空。
    // 这两种用途混用过一次，账面上看着「成功了 16 个会话」，其实 13 个是 0 条。
    const start = saved > 0 ? saved - overlapMs : now - (backfillMs ?? overlapMs);

    const items = await api.listMessages(chatId, start, now, { asUser });
    let missed = 0;

    for (const item of items) {
      if (item.deleted) continue;
      const msg = normalize(item, transport, { chatType });
      if (db.getMessage(msg.message_id)) continue;

      if (msg.sender_type === 'user') {
        // 真漏了：走同一个入口补录，行为与实时那条线完全一致
        handleEvent(msg);
        missed += 1;
      } else {
        // 机器人/应用发的但库里没有——比如本机命令行以同一身份发的，记账不处理
        db.insertOutbound({ ...msg, status: 'done' });
      }
    }

    db.setKv(cursorKey(chatId), String(now));
    if (missed > 0) log?.info('拉取补录', { chatId, missed, scanned: items.length });
    return { scanned: items.length, missed };
  }

  return { pullChat };
}
