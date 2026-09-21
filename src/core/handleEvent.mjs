// 事件入口的**唯一**实现。WS、webhook、对账补录三条来源都走这里，保证行为一致。
// 只做去重落库 + 唤醒 worker，**不做任何网络或文件 IO**：webhook 要求 3 秒内回 200，
// 下载附件和发卡片全在 worker 里异步做。（SQLite 是本地同步写，不算 IO 负担。）
//
// 附件清单和「该不该忽略」在这里就定下来：messages 表没有这两列，
// 等 worker 从库里捞行时已经看不见 normalize 的产物了。
export function createHandleEvent({ db, config, log, wake }) {
  const teacherId = config.teacher_open_id;

  /**
   * 群里没有直接 @ 机器人的消息：**照常入库，但不转发**（用户 2026-09-21 定）。
   *
   * 判断放在这里而不是 worker：mentions 是 normalize 的产物，messages 表没有这一列，
   * worker 从库里捞行时已经看不见了——和 attachments / ignore 同理。
   *
   * 认不出自己（拿不到机器人 open_id）时**退回照转**：多推一张卡片只是吵，
   * 把真的 @ 静默吞掉是丢消息。
   */
  function groupNotForMe(msg) {
    if (msg.chat_type !== 'group') return false;
    const botId = config.bot_open_id ?? db.getKv('bot_open_id');
    if (!botId) return false;
    return !(msg.mentions ?? []).some((m) => m?.open_id === botId);
  }

  return function handleEvent(msg) {
    if (!msg?.message_id) {
      log.warn('丢弃无 message_id 的事件', { transport: msg?.transport });
      return { dup: false, dropped: true };
    }

    const ignored = msg.ignore === true
      || (msg.sender_type && msg.sender_type !== 'user')
      || msg.msg_type === 'interactive'    // 机器人自己发的卡片会回流
      || groupNotForMe(msg);

    const { dup } = db.insertInbound({ ...msg, status: ignored ? 'ignored' : 'new' });
    if (dup) return { dup: true };

    for (const a of msg.attachments ?? []) {
      db.addAttachment({
        messageId: msg.message_id, fileKey: a.file_key, kind: a.kind, fileName: a.file_name,
      });
    }

    if (msg.sender_open_id) {
      db.upsertContact({
        openId: msg.sender_open_id,
        role: msg.sender_open_id === teacherId ? 'teacher' : 'unknown',
        line: msg.sender_open_id === teacherId ? 'self' : null,
      });
    }
    db.upsertChat({
      chatId: msg.chat_id,
      chatType: msg.chat_type,
      peerOpenId: msg.chat_type === 'p2p' ? msg.sender_open_id : null,
      lastMsgAt: msg.create_time,
      // 实时事件只可能来自机器人所在的会话，所以能置 1；
      // 但 poll 来源不行——那可能是用户身份拉到的、机器人根本进不去的会话。
      botMember: (msg.transport === 'ws' || msg.transport === 'webhook') ? 1 : undefined,
    });

    if (!ignored) wake?.();
    return { dup: false, ignored };
  };
}
