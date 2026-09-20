import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.mjs';
import { createFakeApi } from '../src/lark/fake.mjs';
import { createArchiver } from '../src/health/archiver.mjs';

const OWNER = 'ou_owner';
const PEER_A = 'ou_peer_aaaaaa';
const PEER_B = 'ou_peer_bbbbbb';
const silent = { info() {}, warn() {}, error() {} };

function fakeHealth() {
  const s = { archiveFailStreak: 0 };
  return { get: () => ({ ...s }), set: (p) => Object.assign(s, p) };
}

function listItem(over = {}) {
  return {
    message_id: 'om_a1',
    chat_id: 'oc_p2p_a',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '老师在吗' }) },
    sender: { id: PEER_A, sender_type: 'user', id_type: 'open_id' },
    create_time: String(Date.now()),
    ...over,
  };
}

function rig({ token = 'uat_1' } = {}) {
  const db = openDb(':memory:');
  const api = createFakeApi({ log: silent });
  const health = fakeHealth();
  const got = [];
  const userToken = { getAccessToken: async () => { if (!token) throw new Error('尚未授权'); return token; } };
  const archiver = createArchiver({
    db, api, userToken, health, log: silent,
    config: { teacher_open_id: OWNER, reconcile: { overlap_sec: 600 } },
    handleEvent: (m) => { got.push(m); db.insertInbound(m); return { dup: false }; },
  });
  return { db, api, health, archiver, got };
}

describe('归档器：会话发现', () => {
  let r;
  beforeEach(() => { r = rig(); });

  test('路线 A：能列出单聊就用列表，并登记进 chats', async () => {
    r.api.chats = [
      { chat_id: 'oc_p2p_a', chat_mode: 'p2p', p2p_target_id: PEER_A },
      { chat_id: 'oc_group_1', chat_mode: 'group' },
    ];
    const found = await r.archiver.discover('uat_1');
    assert.equal(found.length, 2);
    assert.equal(r.db.getKv('archiver_discovery_mode'), 'list');
    const rows = r.db.listPollableChats();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((x) => x.chat_id === 'oc_p2p_a').peer_open_id, PEER_A);
  });

  test('路线 B：列表里没有单聊就降级为按联系人解析', async () => {
    r.api.chats = [{ chat_id: 'oc_group_1', chat_mode: 'group' }]; // 只有群，没单聊
    r.db.upsertContact({ openId: PEER_A, name: '甲', role: 'student' });
    r.db.upsertContact({ openId: PEER_B, name: '乙', role: 'student' });
    r.db.upsertContact({ openId: OWNER, name: '我', role: 'teacher' });

    const found = await r.archiver.discover('uat_1');
    assert.equal(r.db.getKv('archiver_discovery_mode'), 'contacts');
    assert.equal(found.length, 2, '本人自己那条要排除掉');
    const called = r.api.calls.find((c) => c.method === 'resolveP2pChats');
    assert.ok(called);
    assert.ok(!called.args[0].includes(OWNER), '不该拿自己去换单聊');
  });

  test('列会话直接报错也降级，不让整轮挂掉', async () => {
    r.api.failNext('listMyChats', new Error('code=99991663 参数不支持'));
    r.db.upsertContact({ openId: PEER_A, name: '甲', role: 'student' });
    const found = await r.archiver.discover('uat_1');
    assert.equal(found.length, 1);
    assert.equal(r.db.getKv('archiver_discovery_mode'), 'contacts');
  });

  test('降级过一次就记住，不再每轮白试列表', async () => {
    r.api.chats = [];
    r.db.upsertContact({ openId: PEER_A, name: '甲', role: 'student' });
    await r.archiver.discover('uat_1');
    const firstTry = r.api.calls.filter((c) => c.method === 'listMyChats').length;
    await r.archiver.discover('uat_1');
    const secondTry = r.api.calls.filter((c) => c.method === 'listMyChats').length;
    assert.equal(firstTry, 1);
    assert.equal(secondTry, 1, '第二轮不该再试列表');
  });
});

describe('归档器：拉取', () => {
  let r;
  beforeEach(() => { r = rig(); });

  test('别人私聊你本人的消息会被补录', async () => {
    r.api.chats = [{ chat_id: 'oc_p2p_a', chat_mode: 'p2p', p2p_target_id: PEER_A }];
    r.api.inbox = [listItem()];
    const res = await r.archiver.once();
    assert.equal(res.missed, 1);
    assert.equal(r.got[0].message_id, 'om_a1');
    assert.equal(r.got[0].transport, 'poll');
    assert.equal(r.db.getMessage('om_a1').direction, 'in');
  });

  test('已经在库里的不重复补录', async () => {
    r.api.chats = [{ chat_id: 'oc_p2p_a', chat_mode: 'p2p', p2p_target_id: PEER_A }];
    r.api.inbox = [listItem()];
    await r.archiver.once();
    r.got.length = 0;
    await r.archiver.once();
    assert.equal(r.got.length, 0);
  });

  test('单个会话读不了只记失败，其他会话照拉', async () => {
    r.api.chats = [
      { chat_id: 'oc_p2p_a', chat_mode: 'p2p', p2p_target_id: PEER_A },
      { chat_id: 'oc_p2p_b', chat_mode: 'p2p', p2p_target_id: PEER_B },
    ];
    r.api.inbox = [listItem()];
    r.api.failNext('listMessages', new Error('没权限'));
    const res = await r.archiver.once();
    assert.equal(res.failed, 1);
    assert.equal(res.chats, 2);
    assert.ok(res.scanned >= 1, '另一个会话仍然拉到了');
  });

  test('游标推进后下一轮只拉重叠窗口', async () => {
    r.api.chats = [{ chat_id: 'oc_p2p_a', chat_mode: 'p2p', p2p_target_id: PEER_A }];
    const T = 1_700_000_000_000;
    await r.archiver.once({ now: T });
    await r.archiver.once({ now: T });
    const last = r.api.calls.filter((c) => c.method === 'listMessages').at(-1);
    assert.equal(last.args[1], T - 600_000, '起点要回退一个重叠窗口');
  });

  test('拉取时带的是用户令牌，不是机器人身份', async () => {
    r.api.chats = [{ chat_id: 'oc_p2p_a', chat_mode: 'p2p', p2p_target_id: PEER_A }];
    await r.archiver.once();
    const call = r.api.calls.find((c) => c.method === 'listMessages');
    assert.equal(call.args[3].asUser, 'uat_1');
  });

  test('未授权时整轮失败但不抛，状态里能看出来', async () => {
    const r2 = rig({ token: null });
    const res = await r2.archiver.safeOnce();
    assert.match(res.error, /尚未授权/);
    assert.equal(r2.health.get().archiveFailStreak, 1);
  });

  test('成功一轮会把失败计数清零', async () => {
    r.health.set({ archiveFailStreak: 3 });
    r.api.chats = [{ chat_id: 'oc_p2p_a', chat_mode: 'p2p', p2p_target_id: PEER_A }];
    await r.archiver.once();
    assert.equal(r.health.get().archiveFailStreak, 0);
  });
});
