// SQLite 数据层：node:sqlite（Node 内置，免编译，slim 镜像也能跑）。
// 迁移器读 src/schema/NNN_*.sql 按序号执行，执行记录进 schema_migrations，重复 open 不重跑。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_DIR = join(import.meta.dirname, 'schema');

// 对象/数组转 JSON 存列；已是字符串就原样存，避免被二次转义。
// content_json 是 NOT NULL，undefined/null 落成字符串 'null'（合法 JSON），不违反约束。
function toJsonRequired(v) {
  if (v === undefined || v === null) return 'null';
  return typeof v === 'string' ? v : JSON.stringify(v);
}
function toJsonOptional(v) {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function hasTable(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// 幂等：只跑 schema_migrations 里没记录过的文件号；001 本身建这张表，先判存在性再查已执行集合。
function migrate(db) {
  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const applied = hasTable(db, 'schema_migrations')
    ? new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id))
    : new Set();

  for (const file of files) {
    const id = Number(file.match(/^(\d+)_/)[1]);
    if (applied.has(id)) continue;
    const sql = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${file} 失败：${e.message}`);
    }
  }
}

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  const insertMessageStmt = db.prepare(`
    INSERT OR IGNORE INTO messages (
      message_id, direction, transport, chat_id, chat_type,
      sender_open_id, sender_type, msg_type, text, content_json,
      reply_to, root_id, thread_id, create_time, received_at,
      status, raw_json
    ) VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?)
  `);

  function insertMessageRow(direction, msg, statusDefault) {
    const now = Date.now();
    return insertMessageStmt.run(
      msg.message_id,
      direction,
      msg.transport,
      msg.chat_id,
      msg.chat_type,
      msg.sender_open_id ?? null,
      msg.sender_type ?? null,
      msg.msg_type,
      msg.text ?? null,
      toJsonRequired(msg.content),
      msg.reply_to ?? null,
      msg.root_id ?? null,
      msg.thread_id ?? null,
      msg.create_time ?? now,
      now,
      msg.status ?? statusDefault,
      toJsonOptional(msg.raw),
    );
  }

  // 去重靠 INSERT OR IGNORE + message_id 主键，changes===0 说明已存在。
  function insertInbound(msg) {
    const info = insertMessageRow('in', msg, 'new');
    return { dup: info.changes === 0 };
  }

  // 出站记录默认落 done：这是「已发出」的存档，不进 claimNewMessages 的处理队列。
  function insertOutbound(row) {
    const info = insertMessageRow('out', row, 'done');
    return { dup: info.changes === 0 };
  }

  function getMessage(messageId) {
    return db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
  }

  function listMessages({ since = 0, limit = 50 } = {}) {
    return db
      .prepare('SELECT * FROM messages WHERE create_time >= ? ORDER BY create_time DESC LIMIT ?')
      .all(since, limit);
  }

  // 用一条 UPDATE ... RETURNING 保证「挑 N 条 + 标记 processing」不被并发重复挑走。
  const claimNewStmt = db.prepare(`
    UPDATE messages SET status = 'processing'
    WHERE message_id IN (
      SELECT message_id FROM messages WHERE status = 'new' ORDER BY create_time ASC LIMIT ?
    )
    RETURNING *
  `);
  function claimNewMessages(limit) {
    return claimNewStmt.all(limit);
  }

  function finishMessage(messageId, status, error = null) {
    if (status === 'failed') {
      return db
        .prepare('UPDATE messages SET status = ?, attempts = attempts + 1, last_error = ? WHERE message_id = ?')
        .run(status, error, messageId);
    }
    return db.prepare('UPDATE messages SET status = ? WHERE message_id = ?').run(status, messageId);
  }

  function retryMessage(messageId, error) {
    db.prepare(
      "UPDATE messages SET status = 'new', attempts = attempts + 1, last_error = ? WHERE message_id = ?",
    ).run(error, messageId);
    return db.prepare('SELECT attempts FROM messages WHERE message_id = ?').get(messageId)?.attempts;
  }

  // 人工确认过的 role/line 不许被后到的弱信息（'unknown'/null）冲掉。
  function upsertContact({ openId, name, role, line }) {
    const now = Date.now();
    const existing = db.prepare('SELECT * FROM contacts WHERE open_id = ?').get(openId);
    if (!existing) {
      db.prepare(
        'INSERT INTO contacts (open_id, name, role, line, first_seen, last_seen) VALUES (?,?,?,?,?,?)',
      ).run(openId, name ?? null, role ?? 'unknown', line ?? null, now, now);
      return;
    }
    const nextRole = role && role !== 'unknown' ? role : existing.role;
    const nextLine = line ?? existing.line;
    const nextName = name ?? existing.name;
    db.prepare('UPDATE contacts SET name = ?, role = ?, line = ?, last_seen = ? WHERE open_id = ?').run(
      nextName,
      nextRole,
      nextLine,
      now,
      openId,
    );
  }

  // poll_cursor 不在 SET 列里，保证刷新会话元信息时不会把独立维护的对账游标带丢。
  const upsertChatStmt = db.prepare(`
    INSERT INTO chats (chat_id, chat_type, peer_open_id, last_msg_at) VALUES (?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET
      chat_type = excluded.chat_type,
      peer_open_id = COALESCE(excluded.peer_open_id, chats.peer_open_id),
      last_msg_at = COALESCE(excluded.last_msg_at, chats.last_msg_at)
  `);
  function upsertChat({ chatId, chatType, peerOpenId, lastMsgAt }) {
    upsertChatStmt.run(chatId, chatType, peerOpenId ?? null, lastMsgAt ?? null);
  }

  function setPollCursor(chatId, cursor) {
    db.prepare('UPDATE chats SET poll_cursor = ? WHERE chat_id = ?').run(cursor, chatId);
  }

  function listPollableChats() {
    return db.prepare('SELECT * FROM chats').all();
  }

  function addAttachment({ messageId, fileKey, kind, fileName }) {
    const info = db
      .prepare('INSERT OR IGNORE INTO attachments (message_id, file_key, kind, file_name) VALUES (?,?,?,?)')
      .run(messageId, fileKey, kind, fileName ?? null);
    if (info.changes > 0) return Number(info.lastInsertRowid);
    return db.prepare('SELECT id FROM attachments WHERE message_id = ? AND file_key = ?').get(messageId, fileKey).id;
  }

  const ATTACHMENT_PATCH_FIELDS = ['mime', 'size', 'sha256', 'local_path', 'status', 'error', 'downloaded_at'];
  function updateAttachment(id, patch) {
    const fields = Object.keys(patch).filter((k) => ATTACHMENT_PATCH_FIELDS.includes(k));
    if (fields.length === 0) return;
    const setClause = fields.map((f) => `${f} = ?`).join(', ');
    db.prepare(`UPDATE attachments SET ${setClause} WHERE id = ?`).run(...fields.map((f) => patch[f]), id);
  }

  function listAttachments(messageId) {
    return db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(messageId);
  }

  function enqueue(row) {
    const now = Date.now();
    const info = db
      .prepare(`
        INSERT INTO outbox (
          uuid, target_type, target_id, msg_type, payload_json,
          reply_to, purpose, route_origin, identity, next_at, created_at
        ) VALUES (?,?,?,?,?, ?,?,?,?,?,?)
      `)
      .run(
        row.uuid ?? randomUUID(),
        row.target_type,
        row.target_id,
        row.msg_type,
        toJsonRequired(row.payload_json),
        row.reply_to ?? null,
        row.purpose,
        row.route_origin ?? null,
        row.identity ?? 'bot',
        row.next_at ?? now,
        now,
      );
    return Number(info.lastInsertRowid);
  }

  const claimDueStmt = db.prepare(`
    UPDATE outbox SET status = 'sending'
    WHERE id IN (
      SELECT id FROM outbox WHERE status = 'queued' AND next_at <= ? ORDER BY next_at ASC LIMIT ?
    )
    RETURNING *
  `);
  function claimDueOutbox(limit, now = Date.now()) {
    return claimDueStmt.all(now, limit);
  }

  function markOutboxSent(id, messageId) {
    db.prepare("UPDATE outbox SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ?").run(
      messageId,
      Date.now(),
      id,
    );
  }

  // terminal=false：回 queued 并顺延 next_at（重试）；terminal=true：定格 failed。两种都计 attempts。
  function markOutboxFailed(id, error, nextAt, terminal = false) {
    db.prepare('UPDATE outbox SET status = ?, attempts = attempts + 1, last_error = ?, next_at = ? WHERE id = ?').run(
      terminal ? 'failed' : 'queued',
      error,
      nextAt,
      id,
    );
  }

  function addRoute(route) {
    db.prepare(`
      INSERT INTO routes (
        relay_message_id, origin_message_id, origin_chat_id, origin_open_id, origin_kind, line, created_at
      ) VALUES (?,?,?,?,?,?,?)
    `).run(
      route.relay_message_id,
      route.origin_message_id,
      route.origin_chat_id,
      route.origin_open_id,
      route.origin_kind,
      route.line ?? null,
      route.created_at ?? Date.now(),
    );
  }

  function findRoute(relayMessageId) {
    return db.prepare('SELECT * FROM routes WHERE relay_message_id = ?').get(relayMessageId);
  }

  function getKv(key) {
    return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value;
  }

  function setKv(key, value) {
    db.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, value, Date.now());
  }

  function counts() {
    const messages = { new: 0, processing: 0, failed: 0, done: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM messages GROUP BY status').all()) {
      if (r.status in messages) messages[r.status] = r.n;
    }
    const outbox = { queued: 0, failed: 0, sent: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all()) {
      if (r.status in outbox) outbox[r.status] = r.n;
    }
    return { messages, outbox };
  }

  return {
    raw: db,
    insertInbound,
    insertOutbound,
    getMessage,
    listMessages,
    claimNewMessages,
    finishMessage,
    retryMessage,
    upsertContact,
    upsertChat,
    setPollCursor,
    listPollableChats,
    addAttachment,
    updateAttachment,
    listAttachments,
    enqueue,
    claimDueOutbox,
    markOutboxSent,
    markOutboxFailed,
    addRoute,
    findRoute,
    getKv,
    setKv,
    counts,
  };
}
