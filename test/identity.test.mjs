// 回传用谁的名义发，以及用户身份不可用时怎么降级。
// 这条路径出错的后果是「对方收到的落款不是他以为的那个人」，所以每种情形都钉一条。
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.mjs';
import { createFakeApi } from '../src/lark/fake.mjs';
import { createFiles } from '../src/core/files.mjs';
import { createOutbox } from '../src/core/outbox.mjs';
import { createRouter } from '../src/core/router.mjs';
import { createWorker } from '../src/core/worker.mjs';
import { createHandleEvent } from '../src/core/handleEvent.mjs';

const OWNER = 'ou_owner';
const PEER = 'ou_peer';
const roots = [];
const silent = { info() {}, warn() {}, error() {} };

async function makeRig({ token = 'uat_1', tokenError = null, withUserToken = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'larkrelay-idn-'));
  roots.push(root);
  const config = {
    teacher_open_id: OWNER,
    teacher_name: '主人',
    paths: { files: root },
    limits: { max_download_mb: 100, min_free_gb: 0 },
  };
  const db = openDb(':memory:');
  const api = createFakeApi({ log: silent });
  const files = createFiles({ config, log: silent });
  const userToken = withUserToken
    ? { getAccessToken: async () => { if (tokenError) throw new Error(tokenError); return token; } }
    : undefined;
  const outbox = createOutbox({ db, api, files, log: silent, userToken });
  outbox.setOwnerTarget({ type: 'open_id', id: OWNER });
  const router = createRouter({ db });
  const worker = createWorker({ db, api, files, outbox, router, config, log: silent });
  const handleEvent = createHandleEvent({ db, config, log: silent, wake: () => {} });
  const drain = async () => {
    for (let i = 0; i < 6; i += 1) { await worker.tick({ limit: 10 }); await outbox.tick({ limit: 20 }); }
  };
  return { db, api, outbox, worker, handleEvent, drain };
}

function inbound(over = {}) {
  return {
    message_id: 'om_1', chat_id: 'oc_p2p', chat_type: 'p2p',
    sender_open_id: OWNER, sender_type: 'user', msg_type: 'text',
    text: '测试', content: { text: '测试' }, create_time: Date.now(),
    transport: 'ws', attachments: [], ...over,
  };
}

const sent = (api, m) => api.calls.filter((c) => c.method === m);

after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });

// 先造一条「学生来件 → 转发卡片」，再让主人回复那张卡片
async function setupReply(rig, replyText = '收到，按这个改') {
  rig.db.upsertContact({ openId: PEER, name: '对方', role: 'student', line: 'thesis' });
  rig.handleEvent(inbound({ message_id: 'om_in', sender_open_id: PEER, text: '老师看下' }));
  await rig.drain();
  rig.api.calls.length = 0;
  rig.handleEvent(inbound({ message_id: 'om_reply', text: replyText, reply_to: 'om_fake_1' }));
  await rig.drain();
}

describe('以主人本人名义回传', () => {
  let rig;
  beforeEach(async () => { rig = await makeRig(); });

  test('用户身份可用时：带用户令牌发，且不加前缀', async () => {
    await setupReply(rig);
    const relay = sent(rig.api, 'sendText').find((c) => c.args[0].id === PEER);
    assert.ok(relay, '必须发给原主');
    assert.equal(relay.args[1], '收到，按这个改', '以本人名义发就不该有转达前缀');
    assert.equal(relay.args[2].asUser, 'uat_1', '必须带用户令牌，否则就是机器人在说话');
  });

  test('给主人的回执仍走机器人身份', async () => {
    await setupReply(rig);
    const receipt = sent(rig.api, 'sendText').find((c) => c.args[0].id === OWNER);
    assert.match(receipt.args[1], /已发给/);
    assert.equal(receipt.args[2].asUser, undefined);
  });

  test('附件也以本人名义发过去', async () => {
    rig.db.upsertContact({ openId: PEER, name: '对方', role: 'student' });
    rig.handleEvent(inbound({ message_id: 'om_in', sender_open_id: PEER, text: '交作业' }));
    await rig.drain();
    rig.api.calls.length = 0;
    rig.handleEvent(inbound({
      message_id: 'om_reply', text: null, reply_to: 'om_fake_1', msg_type: 'file',
      attachments: [{ file_key: 'fk_1', kind: 'file', file_name: '批注.pdf' }],
    }));
    await rig.drain();
    const f = sent(rig.api, 'sendFile').find((c) => c.args[0].id === PEER);
    assert.ok(f);
    assert.equal(f.args[2].asUser, 'uat_1');
  });
});

describe('用户身份不可用时的降级', () => {
  test('令牌失效：改用机器人发，正文补回转达前缀', async () => {
    const rig = await makeRig({ tokenError: '用户令牌已失效（invalid_grant），需要重新授权' });
    await setupReply(rig);
    const relay = sent(rig.api, 'sendText').find((c) => c.args[0].id === PEER);
    assert.ok(relay, '降级也要把话送到，不能干脆不发');
    assert.equal(relay.args[1], '主人回复：收到，按这个改', '机器人说话就必须让对方看出是转达');
    assert.equal(relay.args[2].asUser, undefined);
  });

  test('降级会告诉主人一声，免得他以为对方看到的是自己的口吻', async () => {
    const rig = await makeRig({ tokenError: '尚未授权' });
    await setupReply(rig);
    const alerts = sent(rig.api, 'sendText')
      .filter((c) => c.args[0].id === OWNER && /以机器人名义/.test(c.args[1]));
    assert.equal(alerts.length, 1);
  });

  test('降级提醒不会套娃（提醒本身失败不再提醒）', async () => {
    const rig = await makeRig({ tokenError: '尚未授权' });
    await setupReply(rig);
    for (let i = 0; i < 5; i += 1) await rig.outbox.tick({ limit: 20 });
    const alerts = sent(rig.api, 'sendText')
      .filter((c) => c.args[0].id === OWNER && /以机器人名义/.test(c.args[1]));
    assert.equal(alerts.length, 1, '反复 tick 也只该有一条');
  });

  test('根本没接用户身份时同样降级，不报错', async () => {
    const rig = await makeRig({ withUserToken: false });
    await setupReply(rig);
    const relay = sent(rig.api, 'sendText').find((c) => c.args[0].id === PEER);
    assert.equal(relay.args[1], '主人回复：收到，按这个改');
  });
});

describe('机器人身份的出站不受影响', () => {
  test('转发卡片仍是机器人发的，不带用户令牌', async () => {
    const rig = await makeRig();
    rig.db.upsertContact({ openId: PEER, name: '对方', role: 'student' });
    rig.handleEvent(inbound({ message_id: 'om_in', sender_open_id: PEER, text: '你好' }));
    await rig.drain();
    const card = sent(rig.api, 'sendCard')[0];
    assert.equal(card.args[0].id, OWNER);
    assert.equal(card.args[2].asUser, undefined);
  });
});
