// 出站队列。所有对外发送都经这里，为的是三件事：
// 幂等（uuid 交给飞书，重试不会重发）、退避重试、以及**发送成功后才登记 routes**
// （routes 的键是飞书返回的 message_id，发之前根本不存在）。
import { randomUUID } from 'node:crypto';

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export function backoffAt(attempts, now = Date.now()) {
  return now + Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

export function createOutbox({ db, api, files, log }) {
  // purpose: forward | relay_reply | receipt | alert | manual
  function queue({ target, msgType, payload, replyTo, purpose, routeOrigin }) {
    return db.enqueue({
      uuid: randomUUID(),
      target_type: target.type,
      target_id: target.id,
      msg_type: msgType,
      payload_json: payload,
      reply_to: replyTo ?? null,
      purpose,
      route_origin: routeOrigin ? JSON.stringify(routeOrigin) : null,
    });
  }

  async function send(row) {
    const target = { type: row.target_type, id: row.target_id };
    const payload = JSON.parse(row.payload_json);
    const opts = { replyTo: row.reply_to ?? undefined, uuid: row.uuid };
    switch (row.msg_type) {
      case 'text': return api.sendText(target, payload.text, opts);
      case 'interactive': return api.sendCard(target, payload.card, opts);
      case 'file': return api.sendFile(target, files.absOf(payload.path), { ...opts, fileName: payload.file_name });
      case 'image': return api.sendImage(target, files.absOf(payload.path), opts);
      default: throw new Error(`未知出站类型 ${row.msg_type}`);
    }
  }

  // 一轮：取到期的、串行发。串行是刻意的——飞书对单应用发送有频率限制，
  // 而且转发卡片必须先于随后的附件消息到达，并发会打乱顺序。
  async function tick({ limit = 5, now = Date.now() } = {}) {
    const rows = db.claimDueOutbox(limit, now);
    let sent = 0;
    for (const row of rows) {
      try {
        const res = await send(row);
        const messageId = res?.message_id ?? null;
        db.markOutboxSent(row.id, messageId);
        sent += 1;

        if (messageId) {
          db.insertOutbound({
            message_id: messageId,
            transport: 'api',
            chat_id: row.target_type === 'chat_id' ? row.target_id : `p2p:${row.target_id}`,
            chat_type: row.target_type === 'chat_id' ? 'group' : 'p2p',
            sender_type: 'app',
            msg_type: row.msg_type,
            text: row.msg_type === 'text' ? JSON.parse(row.payload_json).text : null,
            content: row.payload_json,
            reply_to: row.reply_to,
            create_time: Date.now(),
          });
          if (row.route_origin) {
            const o = JSON.parse(row.route_origin);
            db.addRoute({
              relay_message_id: messageId,
              origin_message_id: o.origin_message_id,
              origin_chat_id: o.origin_chat_id,
              origin_open_id: o.origin_open_id,
              origin_kind: o.origin_kind,
              line: o.line ?? null,
            });
          }
        }
      } catch (e) {
        const attempts = row.attempts + 1;
        const terminal = attempts >= MAX_ATTEMPTS;
        db.markOutboxFailed(row.id, e.message, backoffAt(attempts, now), terminal);
        log[terminal ? 'error' : 'warn']('出站失败', {
          id: row.id, purpose: row.purpose, attempts, terminal, err: e.message,
        });
      }
    }
    return { claimed: rows.length, sent };
  }

  return { queue, tick };
}
