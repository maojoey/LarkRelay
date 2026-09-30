// 上游通知拉取器：拉队列 → 按姓名解析收件人（单聊对端 + 机器人所在群的成员）→
// 以主人本人名义入队 → 回执。收件人解析是唯一的高风险面——发错人不可接受，
// 所以「0 命中 / 多命中一律不发」和「幂等不重复入队」是本文件测试的重点。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.mjs';
import { createFakeApi } from '../src/lark/fake.mjs';
import { createOutbox } from '../src/core/outbox.mjs';
import { createUpstream } from '../src/core/upstream.mjs';

const OWNER = 'ou_owner';
const PEER_A = 'ou_peer_aaaaaa'; // 单聊对端，联系人表里已有名字
const PEER_B = 'ou_peer_bbbbbb'; // 单聊对端，名字缺失，要靠接口补
const PEER_C = 'ou_peer_cccccc'; // 只在群里，没私聊过
const PEER_D = 'ou_peer_dddddd'; // 模拟「新入群」，还没进本地群成员缓存
const silent = { info() {}, warn() {}, error() {} };

function fakeHealth() {
  const s = {};
  return { get: () => ({ ...s }), set: (p) => Object.assign(s, p) };
}

function notice(over = {}) {
  return { id: 'n1', kind: 'reminder', username: 'stu001', name: '甲', text: '请提交作业', created_at: 1, ...over };
}

// 假 fetch：GET 走 getHandler（默认回一批 notices），POST .../{id}/ack 走 ackHandler。
function makeFetch({ notices = [], ackHandler, getHandler } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (opts.method === 'POST') {
      const id = decodeURIComponent(url.split('/').slice(-2, -1)[0]);
      const body = JSON.parse(opts.body);
      const result = ackHandler ? await ackHandler(id, body, calls.filter((c) => c.opts.method === 'POST').length) : { ok: true };
      if (result?.networkFail) throw new Error('网络不通');
      if (result?.httpFail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => (result ?? { ok: true }) };
    }
    if (getHandler) return getHandler();
    return { ok: true, status: 200, json: async () => ({ ok: true, notices }) };
  };
  return { calls, fetchImpl };
}

function rig({ fetchImpl } = {}) {
  const db = openDb(':memory:');
  const api = createFakeApi({ log: silent });
  const health = fakeHealth();
  const outbox = createOutbox({ db, api, files: undefined, log: silent, userToken: undefined });
  const config = {
    teacher_open_id: OWNER,
    secrets: { upstream_token: 'tok_1' },
    upstream_notices: { url: 'http://upstream.local/notices', interval_sec: 60 },
  };
  const upstream = createUpstream({ db, api, outbox, userToken: undefined, config, log: silent, health, fetchImpl });
  return { db, api, health, outbox, upstream };
}

function outboxRow(db, uuid) {
  return db.raw.prepare('SELECT * FROM outbox WHERE uuid = ?').get(uuid);
}

describe('功能开关', () => {
  test('config 里没有 upstream_notices 就是关闭，safeOnce 直接短路，不发请求', async () => {
    const db = openDb(':memory:');
    const api = createFakeApi({ log: silent });
    const outbox = createOutbox({ db, api, files: undefined, log: silent, userToken: undefined });
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({ ok: true, notices: [] }) }; };
    const upstream = createUpstream({
      db, api, outbox, config: { teacher_open_id: OWNER }, log: silent, health: fakeHealth(), fetchImpl,
    });
    assert.equal(upstream.enabled, false);
    assert.deepEqual(await upstream.safeOnce(), { enabled: false });
    assert.equal(called, false);
  });
});

describe('正常一条：入队 owner 身份 + ack ok', () => {
  test('入队时用 owner 身份，正文原样，ack 带 relayId', async () => {
    const f = makeFetch({ notices: [notice({ name: '甲' })] });
    const rr = rig({ fetchImpl: f.fetchImpl });
    rr.db.upsertChat({ chatId: 'oc_p2p_a', chatType: 'p2p', peerOpenId: PEER_A });
    rr.db.upsertContact({ openId: PEER_A, name: '甲', role: 'student' });

    const res = await rr.upstream.safeOnce();
    assert.equal(res.handed, 1);

    const row = outboxRow(rr.db, 'n1');
    assert.ok(row, 'uuid 用上游的 id，飞书那侧也幂等');
    assert.equal(row.identity, 'owner');
    assert.equal(row.purpose, 'upstream');
    assert.equal(row.target_type, 'open_id');
    assert.equal(row.target_id, PEER_A);
    const payload = JSON.parse(row.payload_json);
    assert.equal(payload.text, '请提交作业', '正文原样，不改写');
    assert.equal(payload.fallback_prefix, '（代老师转达）', '前缀用中性说法，不带人名');

    const ackCall = f.calls.find((c) => c.opts.method === 'POST');
    assert.match(ackCall.url, /\/n1\/ack$/);
    assert.equal(ackCall.opts.headers.authorization, 'Bearer tok_1');
    const ackBody = JSON.parse(ackCall.opts.body);
    assert.equal(ackBody.ok, true);
    assert.equal(ackBody.relayId, row.id);

    assert.equal(rr.db.getKv('upstream:n1'), String(row.id));
  });
});

describe('幂等', () => {
  test('重复拉到同一 id：不重复入队，只重发 ack', async () => {
    const f = makeFetch({ notices: [notice({ name: '甲' })] });
    const r = rig({ fetchImpl: f.fetchImpl });
    r.db.upsertChat({ chatId: 'oc_p2p_a', chatType: 'p2p', peerOpenId: PEER_A });
    r.db.upsertContact({ openId: PEER_A, name: '甲', role: 'student' });

    await r.upstream.safeOnce();
    await r.upstream.safeOnce();

    const rows = r.db.raw.prepare('SELECT * FROM outbox WHERE uuid = ?').all('n1');
    assert.equal(rows.length, 1, '第二轮不该再入队');
    const acks = f.calls.filter((c) => c.opts.method === 'POST');
    assert.equal(acks.length, 2, '但每轮都要 ack');
    assert.equal(JSON.parse(acks[1].opts.body).relayId, rows[0].id);
  });

  test('ack 失败后下一轮补 ack，不会再入队一次', async () => {
    let attempt = 0;
    const f = makeFetch({
      notices: [notice({ name: '甲' })],
      ackHandler: () => { attempt += 1; return attempt === 1 ? { httpFail: true } : { ok: true }; },
    });
    const r = rig({ fetchImpl: f.fetchImpl });
    r.db.upsertChat({ chatId: 'oc_p2p_a', chatType: 'p2p', peerOpenId: PEER_A });
    r.db.upsertContact({ openId: PEER_A, name: '甲', role: 'student' });

    const first = await r.upstream.safeOnce();
    assert.equal(first.handed, 0, 'ack 失败这一轮不算送达成功');
    const rowsAfterFirst = r.db.raw.prepare('SELECT * FROM outbox WHERE uuid = ?').all('n1');
    assert.equal(rowsAfterFirst.length, 1, '入队已经发生，只是 ack 没成功');

    const second = await r.upstream.safeOnce();
    assert.equal(second.handed, 0, '第二轮是补 ack，不是新送达');
    const rowsAfterSecond = r.db.raw.prepare('SELECT * FROM outbox WHERE uuid = ?').all('n1');
    assert.equal(rowsAfterSecond.length, 1, '没有重复入队');
    assert.equal(attempt, 2);
  });
});

describe('解析失败：宁可不发也不发错人', () => {
  test('0 命中：ack 带中文原因，私聊和群都没有', async () => {
    const f = makeFetch({ notices: [notice({ id: 'n2', name: '查无此人' })] });
    const r = rig({ fetchImpl: f.fetchImpl });
    await r.upstream.safeOnce();
    const ackBody = JSON.parse(f.calls.find((c) => c.opts.method === 'POST').opts.body);
    assert.equal(ackBody.ok, false);
    assert.match(ackBody.error, /没找到「查无此人」/);
    assert.match(ackBody.error, /私聊和所在群都没有/);
    assert.equal(r.db.raw.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  });

  test('多命中：ack 带中文原因，未自动发送', async () => {
    const f = makeFetch({ notices: [notice({ id: 'n3', name: '重名' })] });
    const r = rig({ fetchImpl: f.fetchImpl });
    r.db.upsertChat({ chatId: 'oc_p2p_a', chatType: 'p2p', peerOpenId: PEER_A });
    r.db.upsertContact({ openId: PEER_A, name: '重名', role: 'student' });
    r.db.upsertChat({ chatId: 'oc_p2p_b', chatType: 'p2p', peerOpenId: PEER_B });
    r.db.upsertContact({ openId: PEER_B, name: '重名', role: 'student' });

    await r.upstream.safeOnce();
    const ackBody = JSON.parse(f.calls.find((c) => c.opts.method === 'POST').opts.body);
    assert.equal(ackBody.ok, false);
    assert.match(ackBody.error, /有多个「重名」，未自动发送/);
    assert.equal(r.db.raw.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  });
});

describe('缓存命中', () => {
  test('第二次解析同一个名字不再重新建候选池 / 调接口', async () => {
    const r = rig({});
    r.db.upsertChat({ chatId: 'oc_p2p_b', chatType: 'p2p', peerOpenId: PEER_B });
    r.api.usersByOpenId[PEER_B] = '乙'; // 联系人表里没名字，第一次要靠接口补

    const first = await r.upstream.resolveRecipient('乙');
    assert.deepEqual(first, { openId: PEER_B });
    const callsAfterFirst = r.api.calls.filter((c) => c.method === 'getUserByOpenId').length;
    assert.equal(callsAfterFirst, 1);

    const second = await r.upstream.resolveRecipient('乙');
    assert.deepEqual(second, { openId: PEER_B });
    assert.equal(
      r.api.calls.filter((c) => c.method === 'getUserByOpenId').length,
      callsAfterFirst,
      '命中 kv 缓存后不该再调接口',
    );
  });
});

describe('名字缺失时补拉', () => {
  test('单聊对端在联系人表里没名字，会调用户信息接口补上', async () => {
    const r = rig({});
    r.db.upsertChat({ chatId: 'oc_p2p_b', chatType: 'p2p', peerOpenId: PEER_B });
    r.api.usersByOpenId[PEER_B] = '乙';

    const resolved = await r.upstream.resolveRecipient('乙');
    assert.deepEqual(resolved, { openId: PEER_B });
    assert.ok(r.api.calls.some((c) => c.method === 'getUserByOpenId' && c.args[0] === PEER_B));
    assert.equal(r.db.raw.prepare('SELECT name FROM contacts WHERE open_id = ?').get(PEER_B).name, '乙');
  });
});

describe('群成员也算候选（很多学生没私聊过，但都在群里）', () => {
  test('群成员名单里的人能被解析出来，且写回 contacts', async () => {
    const r = rig({});
    r.db.upsertChat({ chatId: 'oc_group_1', chatType: 'group', botMember: 1 });
    r.api.chatMembers.oc_group_1 = [{ member_id: PEER_C, name: '丙' }];

    const resolved = await r.upstream.resolveRecipient('丙');
    assert.deepEqual(resolved, { openId: PEER_C });
    assert.equal(r.db.raw.prepare('SELECT name FROM contacts WHERE open_id = ?').get(PEER_C).name, '丙');
  });

  test('同一个人在多个群里出现算同一个 open_id，不算重名', async () => {
    const r = rig({});
    r.db.upsertChat({ chatId: 'oc_group_1', chatType: 'group', botMember: 1 });
    r.db.upsertChat({ chatId: 'oc_group_2', chatType: 'group', botMember: 1 });
    r.api.chatMembers.oc_group_1 = [{ member_id: PEER_C, name: '丙' }];
    r.api.chatMembers.oc_group_2 = [{ member_id: PEER_C, name: '丙' }];

    const resolved = await r.upstream.resolveRecipient('丙');
    assert.deepEqual(resolved, { openId: PEER_C }, '不该因为出现在两个群里就判定为多命中');
  });

  test('0 命中时强制刷新一次群成员名单再判', async () => {
    const r = rig({});
    r.db.upsertChat({ chatId: 'oc_group_1', chatType: 'group', botMember: 1 });
    // 让常规（按 TTL）刷新直接跳过：刚刚"已经刷新过"
    r.db.setKv('upstream_group_members_refreshed_at', String(Date.now()));
    // 群成员刚变化（新入群），本地缓存还不知道
    r.api.chatMembers.oc_group_1 = [{ member_id: PEER_D, name: '丁' }];

    const resolved = await r.upstream.resolveRecipient('丁');
    assert.deepEqual(resolved, { openId: PEER_D });
    assert.equal(
      r.api.calls.filter((c) => c.method === 'listChatMembers').length,
      1,
      '常规刷新因为 TTL 未到被跳过，只有 0 命中触发的强制刷新真的调了接口',
    );
  });
});

describe('拉取失败', () => {
  test('GET 失败不抛，本轮结束，状态里能看出来', async () => {
    const f = makeFetch({ getHandler: () => { throw new Error('连不上上游'); } });
    const r = rig({ fetchImpl: f.fetchImpl });
    const res = await r.upstream.safeOnce();
    assert.match(res.error, /连不上上游/);
    assert.match(r.health.get().upstreamLastError, /连不上上游/);
  });

  test('响应形状不对也不抛', async () => {
    const f = makeFetch({ getHandler: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, notices: 'not-an-array' }) }) });
    const r = rig({ fetchImpl: f.fetchImpl });
    const res = await r.upstream.safeOnce();
    assert.ok(res.error);
  });

  test('非 2xx 也不抛', async () => {
    const f = makeFetch({ getHandler: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    const r = rig({ fetchImpl: f.fetchImpl });
    const res = await r.upstream.safeOnce();
    assert.match(res.error, /500/);
  });
});
