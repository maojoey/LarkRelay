// 消息处理状态机。唯一会改 messages.status 的地方。
//
// 两条分支必须分清，分错就是把话发给错的人：
//   老师发的、**带 reply_to** 的  → 回传给 routes 里记着的原主
//   其他所有人发的（含老师裸发的）→ 当来件，转发一张卡片给老师
import { forwardCard, relayPrefix } from './cards.mjs';

const MAX_ATTEMPTS = 5;

export function createWorker({ db, api, files, outbox, router, config, log }) {
  const teacher = { type: 'open_id', id: config.teacher_open_id };
  const teacherName = config.teacher_name ?? 'Owner';

  // 附件逐个下载。行在 handleEvent 时就建好了（pending），这里只负责取回内容。
  // 失败只记在附件行上，**不让整条消息进重试**——重试会把转发卡片发第二遍。
  async function fetchAttachments(messageId) {
    const out = [];
    for (const a of db.listAttachments(messageId)) {
      if (a.status === 'done') { out.push(a); continue; }
      const r = await files.store({
        api, messageId, fileKey: a.file_key, kind: a.kind, fileName: a.file_name,
      });
      db.updateAttachment(a.id, {
        status: r.status,
        error: r.error ?? null,
        local_path: r.local_path ?? null,
        size: r.size ?? null,
        mime: r.mime ?? null,
        sha256: r.sha256 ?? null,
        downloaded_at: r.status === 'done' ? Date.now() : null,
      });
      out.push({ ...a, ...r, file_name: r.file_name ?? a.file_name });
    }
    return out;
  }

  function contactOf(openId) {
    return db.raw.prepare('SELECT * FROM contacts WHERE open_id = ?').get(openId);
  }

  // 来件：转一张卡片给老师，附件各转一条。卡片与每条附件都登记 routes，
  // 这样老师回复其中任意一条都能找回原主。
  async function forwardToTeacher(msg, attachments) {
    const c = contactOf(msg.sender_open_id);
    const isTeacher = msg.sender_open_id === config.teacher_open_id;
    const line = isTeacher ? 'self' : (c?.line ?? null);
    const name = isTeacher ? `${teacherName}（自测）` : (c?.name ?? msg.sender_open_id ?? '未知');
    const origin = {
      origin_message_id: msg.message_id,
      origin_chat_id: msg.chat_id,
      origin_open_id: msg.sender_open_id,
      origin_kind: isTeacher ? 'self' : (c?.role === 'student' ? 'student' : 'teacher'),
      line,
    };

    outbox.queue({
      target: teacher,
      msgType: 'interactive',
      payload: { card: forwardCard({ name, line, text: msg.text, attachments }) },
      purpose: 'forward',
      routeOrigin: origin,
    });

    for (const a of attachments) {
      if (a.status !== 'done') continue;
      outbox.queue({
        target: teacher,
        msgType: a.kind === 'image' ? 'image' : 'file',
        payload: { path: a.local_path, file_name: a.file_name },
        purpose: 'forward',
        routeOrigin: origin,
      });
    }
  }

  // 回传：老师回复某条转发 → 发给原主。附件同样重新上传过去。
  async function relayReply(msg, attachments, route) {
    const target = { type: 'open_id', id: route.origin_open_id };
    const body = `${relayPrefix(route.origin_kind, teacherName)}${msg.text ?? ''}`.trim();
    if (msg.text) {
      outbox.queue({ target, msgType: 'text', payload: { text: body }, purpose: 'relay_reply' });
    }
    for (const a of attachments) {
      if (a.status !== 'done') continue;
      outbox.queue({
        target,
        msgType: a.kind === 'image' ? 'image' : 'file',
        payload: { path: a.local_path, file_name: a.file_name },
        purpose: 'relay_reply',
      });
    }
    const who = contactOf(route.origin_open_id)?.name
      ?? (route.origin_kind === 'self' ? `${teacherName}（自测）` : route.origin_open_id);
    outbox.queue({
      target: teacher,
      msgType: 'text',
      payload: { text: `已发给 ${who}` },
      replyTo: msg.message_id,
      purpose: 'receipt',
    });
  }

  async function processOne(msg) {
    // 该忽略的（表情包、合并转发、系统消息、机器人自己的卡片、非 user 发件人）
    // 在 handleEvent 就落成 ignored 了，claimNewMessages 捞不到。这里只兜住群消息：
    // 里程碑 1 只做私聊，群要等学生分线落地再开。
    if (msg.chat_type === 'group') return 'ignored';

    const attachments = await fetchAttachments(msg.message_id);

    const isTeacher = msg.sender_open_id === config.teacher_open_id;
    if (isTeacher && msg.reply_to) {
      const r = router.resolve(msg.reply_to);
      if (!r.ok) {
        outbox.queue({
          target: teacher,
          msgType: 'text',
          payload: { text: '这条不是转发消息，没有回传对象。要给谁回话，请回复对应的那张卡片。' },
          replyTo: msg.message_id,
          purpose: 'receipt',
        });
        return 'done';
      }
      await relayReply(msg, attachments, r.route);
      return 'done';
    }

    await forwardToTeacher(msg, attachments);
    return 'done';
  }

  async function tick({ limit = 5 } = {}) {
    const rows = db.claimNewMessages(limit);
    for (const row of rows) {
      try {
        const status = await processOne(row);
        db.finishMessage(row.message_id, status);
      } catch (e) {
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          db.finishMessage(row.message_id, 'failed', e.message);
          log.error('消息处理彻底失败', { messageId: row.message_id, attempts, err: e.message });
        } else {
          db.retryMessage(row.message_id, e.message);
          log.warn('消息处理失败，稍后重试', { messageId: row.message_id, attempts, err: e.message });
        }
      }
    }
    return { claimed: rows.length };
  }

  return { tick, processOne };
}
