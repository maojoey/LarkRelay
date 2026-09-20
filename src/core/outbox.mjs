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

export function createOutbox({ db, api, files, log, userToken }) {
  let ownerTarget = null;
  // purpose: forward | relay_reply | receipt | alert | manual
  // identity: 'bot'（默认）| 'owner'（以主人本人名义发，需要用户身份授权）
  function queue({ target, msgType, payload, replyTo, purpose, routeOrigin, identity = 'bot' }) {
    return db.enqueue({
      uuid: randomUUID(),
      target_type: target.type,
      target_id: target.id,
      msg_type: msgType,
      payload_json: payload,
      reply_to: replyTo ?? null,
      purpose,
      route_origin: routeOrigin ? JSON.stringify(routeOrigin) : null,
      identity,
    });
  }

  /**
   * 解析这一行该用谁的身份发。
   * identity='owner' 但用户身份不可用时**降级成机器人发**，而不是发不出去——
   * 老师回学生一句话，宁可署名变成机器人，也不能干脆没送到。降级会在正文前加回前缀，
   * 并给主人回一条说明，免得他以为学生收到的是自己的口吻。
   */
  async function resolveIdentity(row) {
    if (row.identity !== 'owner') return { asUser: undefined, degraded: false };
    if (!userToken) return { asUser: undefined, degraded: true, why: '未接入用户身份' };
    try {
      return { asUser: await userToken.getAccessToken(), degraded: false };
    } catch (e) {
      return { asUser: undefined, degraded: true, why: e.message };
    }
  }

  async function send(row, { asUser, degraded } = {}) {
    const target = { type: row.target_type, id: row.target_id };
    const payload = JSON.parse(row.payload_json);
    // 降级时才加前缀：以本人名义发的时候加前缀反而怪
    if (degraded && payload.fallback_prefix && payload.text) {
      payload.text = `${payload.fallback_prefix}${payload.text}`;
    }
    const opts = { replyTo: row.reply_to ?? undefined, uuid: row.uuid, asUser };
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
        const idn = await resolveIdentity(row);
        if (idn.degraded) {
          log.warn('以主人身份发送不可用，降级为机器人发送', { id: row.id, why: idn.why });
          notifyDegraded(row, idn.why);
        }
        const res = await send(row, idn);
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

  // 降级只提醒一次，且绝不对提醒本身再提醒——否则一次失败会套出无穷多条
  const degradedNotified = new Set();
  function notifyDegraded(row, why) {
    if (row.purpose === 'alert' || degradedNotified.has(row.id)) return;
    degradedNotified.add(row.id);
    if (!ownerTarget) return;
    queue({
      target: ownerTarget,
      msgType: 'text',
      payload: { text: `刚才那条回复是以机器人名义发出的，不是你本人：${why ?? '用户身份不可用'}。要恢复请重新授权。` },
      purpose: 'alert',
    });
  }

  return { queue, tick, setOwnerTarget: (t) => { ownerTarget = t; } };
}
