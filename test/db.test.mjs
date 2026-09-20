// :memory: 覆盖大多数用例；迁移幂等性必须用真文件（每个 :memory: 连接互不共享）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { openDb } from '../src/db.mjs';

function makeInbound(overrides = {}) {
  return {
    message_id: `om_${randomUUID()}`,
    chat_id: 'oc_1',
    chat_type: 'p2p',
    sender_open_id: 'ou_student',
    sender_type: 'user',
    msg_type: 'text',
    text: 'hi',
    content: { text: 'hi' },
    reply_to: null,
    root_id: null,
    thread_id: null,
    create_time: Date.now(),
    transport: 'ws',
    raw: { foo: 'bar' },
    ...overrides,
  };
}

test('迁移幂等：同一个库 open 两次 schema_migrations 只有一行', () => {
  const path = join(tmpdir(), `larkrelay-test-${randomUUID()}.sqlite`);
  try {
    const db1 = openDb(path);
    db1.raw.close();
    const db2 = openDb(path);
    const rows = db2.raw.prepare('SELECT * FROM schema_migrations').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 1);
    db2.raw.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(path + suffix); } catch { /* 可能不存在 */ }
    }
  }
});

test(':memory: 也能建表跑迁移', () => {
  const db = openDb(':memory:');
  const row = db.raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
  assert.equal(row.n, 1);
});

test('insertInbound 去重：同一 message_id 第二次是 dup', () => {
  const db = openDb(':memory:');
  const msg = makeInbound();
  const first = db.insertInbound(msg);
  const second = db.insertInbound(msg);
  assert.equal(first.dup, false);
  assert.equal(second.dup, true);
  const rows = db.listMessages({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, msg.message_id);
});

test('claimNewMessages 原子性：3 条挑 2 条再挑剩 1 条', () => {
  const db = openDb(':memory:');
  const t0 = Date.now();
  const msgs = [0, 1, 2].map((i) => makeInbound({ create_time: t0 + i }));
  for (const m of msgs) db.insertInbound(m);

  const first = db.claimNewMessages(2);
  assert.equal(first.length, 2);
  for (const r of first) assert.equal(r.status, 'processing');

  const second = db.claimNewMessages(10);
  assert.equal(second.length, 1);
  assert.equal(second[0].status, 'processing');
  assert.equal(second[0].message_id, msgs[2].message_id);

  // 全库应有 2 条 processing + 0 条 new
  const c = db.counts();
  assert.equal(c.messages.processing, 3);
  assert.equal(c.messages.new, 0);
});

test('upsertContact：已确认的 role 不被弱信息覆盖', () => {
  const db = openDb(':memory:');
  const openId = 'ou_1';
  db.upsertContact({ openId, name: '小明', role: 'student', line: 'thesis' });
  const afterFirst = db.raw.prepare('SELECT * FROM contacts WHERE open_id = ?').get(openId);
  assert.equal(afterFirst.role, 'student');
  assert.equal(afterFirst.line, 'thesis');
  const firstSeen = afterFirst.first_seen;

  db.upsertContact({ openId, name: '小明', role: 'unknown', line: null });
  const afterSecond = db.raw.prepare('SELECT * FROM contacts WHERE open_id = ?').get(openId);
  assert.equal(afterSecond.role, 'student');
  assert.equal(afterSecond.line, 'thesis');
  assert.equal(afterSecond.first_seen, firstSeen);
  assert.ok(afterSecond.last_seen >= firstSeen);
});

test('outbox：enqueue → claimDueOutbox → 失败重试延后 next_at → 到期再 claim', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const id = db.enqueue({
    target_type: 'open_id',
    target_id: 'ou_teacher',
    msg_type: 'text',
    payload_json: { text: 'hello' },
    purpose: 'relay',
    next_at: now,
  });
  assert.ok(Number.isInteger(id));

  const claimed = db.claimDueOutbox(10, now);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, id);
  assert.equal(claimed[0].status, 'sending');

  // 立刻再 claim 应该拿不到（已经是 sending）
  assert.equal(db.claimDueOutbox(10, now).length, 0);

  const nextAt = now + 60_000;
  db.markOutboxFailed(id, 'timeout', nextAt, false);
  const afterFail = db.raw.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
  assert.equal(afterFail.status, 'queued');
  assert.equal(afterFail.next_at, nextAt);
  assert.equal(afterFail.attempts, 1);

  // 还没到期，claim 不到
  assert.equal(db.claimDueOutbox(10, now).length, 0);
  // 到期后能再 claim
  const claimedAgain = db.claimDueOutbox(10, nextAt);
  assert.equal(claimedAgain.length, 1);

  db.markOutboxSent(id, 'om_sent_1');
  const sent = db.raw.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.message_id, 'om_sent_1');
});

test('outbox：终态失败直接 failed', () => {
  const db = openDb(':memory:');
  const id = db.enqueue({
    target_type: 'chat_id',
    target_id: 'oc_1',
    msg_type: 'text',
    payload_json: '{"text":"x"}',
    purpose: 'relay',
  });
  db.markOutboxFailed(id, 'boom', Date.now(), true);
  const row = db.raw.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 1);
});

test('routes 往返', () => {
  const db = openDb(':memory:');
  db.addRoute({
    relay_message_id: 'om_relay_1',
    origin_message_id: 'om_origin_1',
    origin_chat_id: 'oc_1',
    origin_open_id: 'ou_student',
    origin_kind: 'student',
    line: 'thesis',
  });
  const found = db.findRoute('om_relay_1');
  assert.equal(found.origin_message_id, 'om_origin_1');
  assert.equal(found.line, 'thesis');
  assert.equal(db.findRoute('om_not_exist'), undefined);
});

test('attachments：UNIQUE(message_id, file_key) 生效', () => {
  const db = openDb(':memory:');
  const msg = makeInbound();
  db.insertInbound(msg);
  const id1 = db.addAttachment({ messageId: msg.message_id, fileKey: 'fk_1', kind: 'image', fileName: 'a.png' });
  const id2 = db.addAttachment({ messageId: msg.message_id, fileKey: 'fk_1', kind: 'image', fileName: 'a.png' });
  assert.equal(id1, id2);
  assert.equal(db.listAttachments(msg.message_id).length, 1);

  db.updateAttachment(id1, { status: 'done', sha256: 'abc', downloaded_at: Date.now() });
  const row = db.raw.prepare('SELECT * FROM attachments WHERE id = ?').get(id1);
  assert.equal(row.status, 'done');
  assert.equal(row.sha256, 'abc');
});

test('counts() 数字对', () => {
  const db = openDb(':memory:');
  const a = makeInbound();
  const b = makeInbound();
  const c = makeInbound();
  db.insertInbound(a);
  db.insertInbound(b);
  db.insertInbound(c);
  const [claimed] = [db.claimNewMessages(1)];
  db.finishMessage(claimed[0].message_id, 'done');
  db.finishMessage(b.message_id === claimed[0].message_id ? a.message_id : b.message_id, 'failed', 'oops');

  const counts = db.counts();
  assert.equal(counts.messages.done, 1);
  assert.equal(counts.messages.failed, 1);
  assert.equal(counts.messages.new, 1);
  assert.equal(counts.messages.processing, 0);

  db.enqueue({ target_type: 'open_id', target_id: 'ou_1', msg_type: 'text', payload_json: {}, purpose: 'relay' });
  const failedOutboxId = db.enqueue({
    target_type: 'open_id', target_id: 'ou_1', msg_type: 'text', payload_json: {}, purpose: 'relay',
  });
  db.markOutboxFailed(failedOutboxId, 'x', Date.now(), true);

  const outCounts = db.counts().outbox;
  assert.equal(outCounts.queued, 1);
  assert.equal(outCounts.failed, 1);
  assert.equal(outCounts.sent, 0);
});

test('kv get/set', () => {
  const db = openDb(':memory:');
  assert.equal(db.getKv('nope'), undefined);
  db.setKv('foo', 'bar');
  assert.equal(db.getKv('foo'), 'bar');
  db.setKv('foo', 'baz');
  assert.equal(db.getKv('foo'), 'baz');
});

test('upsertChat 与 poll_cursor', () => {
  const db = openDb(':memory:');
  db.upsertChat({ chatId: 'oc_1', chatType: 'p2p', peerOpenId: 'ou_1', lastMsgAt: 100 });
  db.setPollCursor('oc_1', 12345);
  db.upsertChat({ chatId: 'oc_1', chatType: 'p2p', peerOpenId: 'ou_1', lastMsgAt: 200 });
  const chat = db.listPollableChats().find((c) => c.chat_id === 'oc_1');
  assert.equal(chat.poll_cursor, 12345);
  assert.equal(chat.last_msg_at, 200);
});
