import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.mjs';
import { createFakeApi } from '../src/lark/fake.mjs';
import { createReconcile } from '../src/health/reconcile.mjs';
import { createWatchdog } from '../src/health/watchdog.mjs';

const TEACHER = 'ou_teacher';
const silent = { info() {}, warn() {}, error() {} };

// health 单例在测试间要能重置，这里用一个同形状的替身
function fakeHealth(init = {}) {
  const s = {
    startedAt: Date.now(), wsState: 'connected', wsLastConnect: Date.now(),
    lastEventAt: null, lastPollAt: null, lastPollMissed: 0,
    pollFailStreak: 0, missed24h: 0, splitSuspect: false, ...init,
  };
  return {
    get: () => ({ ...s }),
    set: (p) => Object.assign(s, p),
    markEvent: () => { s.lastEventAt = Date.now(); },
    addMissed: (n) => { s.missed24h += n; s.lastPollMissed = n; },
  };
}

function listItem(over = {}) {
  return {
    message_id: 'om_missed',
    chat_id: 'oc_p2p',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '你在吗' }) },
    sender: { id: TEACHER, sender_type: 'user', id_type: 'open_id' },
    create_time: String(Date.now()),
    ...over,
  };
}

function rig({ health } = {}) {
  const db = openDb(':memory:');
  const api = createFakeApi({ log: silent });
  const h = health ?? fakeHealth();
  const got = [];
  const config = { teacher_open_id: TEACHER, reconcile: { overlap_sec: 600 } };
  const reconcile = createReconcile({
    db, api, config, log: silent, health: h,
    handleEvent: (m) => { got.push(m); db.insertInbound(m); return { dup: false }; },
  });
  db.upsertChat({ chatId: 'oc_p2p', chatType: 'p2p', peerOpenId: TEACHER });
  return { db, api, health: h, reconcile, got, config };
}

describe('对账轮询', () => {
  let r;
  beforeEach(() => { r = rig(); });

  test('库里没有的用户消息会被补录，走的是同一个 handleEvent', async () => {
    r.api.inbox = [listItem()];
    const res = await r.reconcile.once();
    assert.equal(res.missed, 1);
    assert.equal(r.got.length, 1);
    assert.equal(r.got[0].message_id, 'om_missed');
    assert.equal(r.got[0].transport, 'poll');
    assert.equal(r.health.get().missed24h, 1);
  });

  test('已经在库里的不会重复补录', async () => {
    r.api.inbox = [listItem()];
    await r.reconcile.once();
    r.got.length = 0;
    await r.reconcile.once();
    assert.equal(r.got.length, 0);
  });

  test('机器人发的消息只记账，不当来件处理（本机 lark-cli 发的走这条）', async () => {
    r.api.inbox = [listItem({ message_id: 'om_bot', sender: { id: 'cli_x', sender_type: 'app', id_type: 'app_id' } })];
    const res = await r.reconcile.once();
    assert.equal(res.missed, 0);
    assert.equal(r.got.length, 0);
    assert.equal(r.db.getMessage('om_bot').direction, 'out');
  });

  test('ws 明明 connected 却仍漏了消息 → 判定分流嫌疑', async () => {
    r.api.inbox = [listItem()];
    const res = await r.reconcile.once();
    assert.equal(res.splitSuspect, true);
    assert.equal(r.health.get().splitSuspect, true);
  });

  test('断线期间漏的不算分流嫌疑', async () => {
    const h = fakeHealth({ wsState: 'reconnecting' });
    const r2 = rig({ health: h });
    r2.api.inbox = [listItem()];
    const res = await r2.reconcile.once();
    assert.equal(res.missed, 1);
    assert.equal(res.splitSuspect, false);
  });

  test('拉取失败只累计 failStreak，不抛', async () => {
    r.api.failNext('listMessages', new Error('超时'));
    const res = await r.reconcile.safeOnce();
    assert.ok(res.error);
    assert.equal(r.health.get().pollFailStreak, 1);
  });

  test('游标推进后下一轮只拉重叠窗口', async () => {
    await r.reconcile.once({ now: 1_000_000_000_000 });
    const before = r.api.calls.filter((c) => c.method === 'listMessages').length;
    await r.reconcile.once({ now: 1_000_000_000_000 });
    const call = r.api.calls.filter((c) => c.method === 'listMessages').at(-1);
    assert.equal(before, 1);
    assert.equal(call.args[1], 1_000_000_000_000 - 600_000, '起点要回退一个重叠窗口');
  });
});

describe('看门狗', () => {
  test('ws failed → 判死', async () => {
    const h = fakeHealth({ wsState: 'failed' });
    const w = createWatchdog({ config: {}, log: silent, health: h, notify: async () => {} });
    assert.equal(await w.check(), true);
  });

  test('短暂重连不判死，超过阈值才判死', async () => {
    const h = fakeHealth({ wsState: 'reconnecting' });
    const w = createWatchdog({ config: { watchdog: { disconnected_exit_sec: 180 } }, log: silent, health: h, notify: async () => {} });
    const t0 = Date.now();
    assert.equal(await w.check({ now: t0 }), false);
    assert.equal(await w.check({ now: t0 + 60_000 }), false);
    assert.equal(await w.check({ now: t0 + 200_000 }), true);
  });

  test('连上之后计时清零', async () => {
    const h = fakeHealth({ wsState: 'reconnecting' });
    const w = createWatchdog({ config: { watchdog: { disconnected_exit_sec: 180 } }, log: silent, health: h, notify: async () => {} });
    const t0 = Date.now();
    await w.check({ now: t0 });
    h.set({ wsState: 'connected' });
    await w.check({ now: t0 + 200_000 });
    h.set({ wsState: 'reconnecting' });
    assert.equal(await w.check({ now: t0 + 200_001 }), false, '重新开始计时');
  });

  test('对账连续三次失败 → 判死', async () => {
    const h = fakeHealth({ pollFailStreak: 3 });
    const w = createWatchdog({ config: {}, log: silent, health: h, notify: async () => {} });
    assert.equal(await w.check(), true);
  });

  test('告警有冷却，不会刷屏', async () => {
    const h = fakeHealth({ wsState: 'failed' });
    const sent = [];
    const w = createWatchdog({
      config: { watchdog: { alert_cooldown_sec: 3600 } },
      log: silent, health: h, notify: async (t) => sent.push(t),
    });
    await w.check();
    await w.check();
    assert.equal(sent.length, 1);
  });

  test('告警发不出去也不阻塞判死', async () => {
    const h = fakeHealth({ wsState: 'failed' });
    const w = createWatchdog({
      config: {}, log: silent, health: h,
      notify: async () => { throw new Error('飞书连不上'); },
    });
    assert.equal(await w.check(), true);
  });
});
