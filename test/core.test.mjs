import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.mjs';
import { createFakeApi } from '../src/lark/fake.mjs';
import { createFiles } from '../src/core/files.mjs';
import { createOutbox } from '../src/core/outbox.mjs';
import { createRouter } from '../src/core/router.mjs';
import { createWorker } from '../src/core/worker.mjs';
import { createHandleEvent } from '../src/core/handleEvent.mjs';

const TEACHER = 'ou_teacher';
const STUDENT = 'ou_student';
const roots = [];
const silent = { info() {}, warn() {}, error() {} };

async function makeRig({ limits } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'larkrelay-'));
  roots.push(root);
  const config = {
    teacher_open_id: TEACHER,
    teacher_name: '老师',
    paths: { files: root },
    limits: { max_download_mb: 100, files_soft_quota_gb: 10, files_hard_quota_gb: 15, min_free_gb: 0, ...limits },
  };
  const db = openDb(':memory:');
  const api = createFakeApi({ log: silent });
  const files = createFiles({ config, log: silent });
  const outbox = createOutbox({ db, api, files, log: silent });
  const router = createRouter({ db });
  const worker = createWorker({ db, api, files, outbox, router, config, log: silent });
  const handleEvent = createHandleEvent({ db, config, log: silent, wake: () => {} });
  // 跑到静止：worker 排队 → outbox 发出 → 可能又产生新队列
  const drain = async () => {
    for (let i = 0; i < 6; i += 1) {
      await worker.tick({ limit: 10 });
      await outbox.tick({ limit: 20 });
    }
  };
  return { root, config, db, api, files, outbox, router, worker, handleEvent, drain };
}

function inbound(over = {}) {
  return {
    message_id: 'om_1',
    chat_id: 'oc_p2p',
    chat_type: 'p2p',
    sender_open_id: TEACHER,
    sender_type: 'user',
    msg_type: 'text',
    text: '测试一',
    content: { text: '测试一' },
    create_time: Date.now(),
    transport: 'ws',
    attachments: [],
    ...over,
  };
}

const sent = (api, method) => api.calls.filter((c) => c.method === method);

after(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }); });

describe('原语 1+2：文字来件转发给老师，出站可发', () => {
  let rig;
  beforeEach(async () => { rig = await makeRig(); });

  test('来件落库、转发卡片发出、routes 登记', async () => {
    assert.deepEqual(rig.handleEvent(inbound()), { dup: false, ignored: false });
    await rig.drain();

    const row = rig.db.getMessage('om_1');
    assert.equal(row.direction, 'in');
    assert.equal(row.status, 'done');

    const cards = sent(rig.api, 'sendCard');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].args[0].id, TEACHER);
    assert.match(cards[0].args[1].header.title.content, /老师（自测）/);

    // 卡片发出后才有 message_id，routes 此时才登记得上
    const route = rig.db.findRoute('om_fake_1');
    assert.ok(route, 'routes 应指向原始来件');
    assert.equal(route.origin_message_id, 'om_1');
    assert.equal(route.origin_open_id, TEACHER);
    assert.equal(route.origin_kind, 'self');
  });

  test('服务端主动发文字', async () => {
    rig.outbox.queue({
      target: { type: 'open_id', id: TEACHER },
      msgType: 'text', payload: { text: '你好' }, purpose: 'manual',
    });
    await rig.outbox.tick();
    assert.equal(sent(rig.api, 'sendText').length, 1);
    assert.equal(rig.db.counts().outbox.sent, 1);
    assert.equal(rig.db.getMessage('om_fake_1').direction, 'out');
  });
});

describe('原语 3+4：附件下载落盘、重新上传', () => {
  let rig;
  beforeEach(async () => { rig = await makeRig(); });

  test('文件与图片各落盘一份，并各转一条出去', async () => {
    rig.handleEvent(inbound({
      msg_type: 'file', text: null,
      attachments: [
        { file_key: 'fk_abcdefgh1', kind: 'file', file_name: '开题报告.pdf' },
        { file_key: 'fk_abcdefgh2', kind: 'image', file_name: null },
      ],
    }));
    await rig.drain();

    const atts = rig.db.listAttachments('om_1');
    assert.equal(atts.length, 2);
    for (const a of atts) {
      assert.equal(a.status, 'done');
      assert.ok(a.sha256 && a.size > 0);
      assert.equal(await readFile(path.join(rig.root, a.local_path), 'utf8'), 'fake');
    }
    assert.equal(sent(rig.api, 'sendFile').length, 1);
    assert.equal(sent(rig.api, 'sendImage').length, 1);
    // 卡片里要写明附件已存档
    const card = sent(rig.api, 'sendCard')[0].args[1];
    assert.ok(JSON.stringify(card).includes('开题报告.pdf'));
  });

  test('文件名清洗：路径分隔符与控制字符被去掉', async () => {
    rig.handleEvent(inbound({
      msg_type: 'file', text: null,
      attachments: [{ file_key: 'fk_x', kind: 'file', file_name: 'a/b:c*?.pdf' }],
    }));
    await rig.drain();
    const a = rig.db.listAttachments('om_1')[0];
    assert.equal(path.basename(a.local_path), 'fk_x-abc.pdf');
  });

  test('磁盘余量不足时只标 deferred，消息仍然转发', async () => {
    const r = await makeRig({ limits: { min_free_gb: 1e9 } });
    r.handleEvent(inbound({
      msg_type: 'file', text: '带附件',
      attachments: [{ file_key: 'fk_y', kind: 'file', file_name: 'x.pdf' }],
    }));
    await r.drain();
    const a = r.db.listAttachments('om_1')[0];
    assert.equal(a.status, 'deferred');
    assert.match(a.error, /磁盘剩余不足/);
    assert.equal(sent(r.api, 'download').length, 0);
    assert.equal(sent(r.api, 'sendCard').length, 1, '附件没下来也要把消息转出去');
    assert.equal(r.db.getMessage('om_1').status, 'done');
  });

  test('下载失败只坏一个附件，不拖垮整条消息', async () => {
    rig.api.failNext('download', new Error('网络错误'));
    rig.handleEvent(inbound({
      msg_type: 'file', text: null,
      attachments: [{ file_key: 'fk_z', kind: 'file', file_name: 'x.pdf' }],
    }));
    await rig.drain();
    assert.equal(rig.db.listAttachments('om_1')[0].status, 'failed');
    assert.equal(rig.db.getMessage('om_1').status, 'done');
    assert.equal(sent(rig.api, 'sendCard').length, 1);
  });
});

describe('原语 5：回复路由', () => {
  let rig;
  beforeEach(async () => { rig = await makeRig(); });

  test('回复转发卡片 → 回传给原主 + 给老师回执', async () => {
    // 学生来件
    rig.db.upsertContact({ openId: STUDENT, name: '某同学', role: 'student', line: 'thesis' });
    rig.handleEvent(inbound({ message_id: 'om_s1', sender_open_id: STUDENT, text: '老师我交了' }));
    await rig.drain();
    const card = rig.db.findRoute('om_fake_1');
    assert.equal(card.origin_open_id, STUDENT);
    assert.equal(card.origin_kind, 'student');

    // 老师回复那张卡片
    rig.api.calls.length = 0;
    rig.handleEvent(inbound({ message_id: 'om_t1', text: '收到，改一下第三部分', reply_to: 'om_fake_1' }));
    await rig.drain();

    const texts = sent(rig.api, 'sendText');
    assert.equal(texts.length, 2, '一条回传 + 一条回执');
    const relay = texts.find((c) => c.args[0].id === STUDENT);
    assert.ok(relay, '必须发给原主');
    assert.equal(relay.args[1], '老师回复：收到，改一下第三部分');
    const rcpt = texts.find((c) => c.args[0].id === TEACHER);
    assert.equal(rcpt.args[1], '已发给 某同学');
    assert.equal(rcpt.args[2].replyTo, 'om_t1', '回执要挂在老师那条回复下面');
  });

  test('回复一条不是转发卡片的消息 → 只回执，不发给任何人', async () => {
    rig.handleEvent(inbound({ message_id: 'om_t2', text: '随手一句', reply_to: 'om_不存在' }));
    await rig.drain();
    const texts = sent(rig.api, 'sendText');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].args[0].id, TEACHER);
    assert.match(texts[0].args[1], /不是转发消息/);
    assert.equal(sent(rig.api, 'sendCard').length, 0);
  });

  test('裸消息不当回传（护栏）：老师不带 reply_to 打字只会得到一张自环卡片', async () => {
    rig.db.upsertContact({ openId: STUDENT, name: '某同学', role: 'student', line: 'thesis' });
    rig.handleEvent(inbound({ message_id: 'om_s2', sender_open_id: STUDENT, text: '在吗' }));
    await rig.drain();
    rig.api.calls.length = 0;
    rig.handleEvent(inbound({ message_id: 'om_t3', text: '在的' }));
    await rig.drain();
    assert.equal(sent(rig.api, 'sendText').length, 0, '不许猜收件人');
    assert.equal(sent(rig.api, 'sendCard').length, 1);
  });
});

describe('去重、忽略与重试', () => {
  let rig;
  beforeEach(async () => { rig = await makeRig(); });

  test('同一 message_id 重投不会发第二张卡片', async () => {
    rig.handleEvent(inbound());
    assert.equal(rig.handleEvent(inbound()).dup, true);
    await rig.drain();
    assert.equal(sent(rig.api, 'sendCard').length, 1);
  });

  test('机器人自己的卡片回流、非 user 发件人、被标 ignore 的类型都落 ignored', async () => {
    rig.handleEvent(inbound({ message_id: 'om_i1', msg_type: 'interactive' }));
    rig.handleEvent(inbound({ message_id: 'om_i2', sender_type: 'app' }));
    rig.handleEvent(inbound({ message_id: 'om_i3', msg_type: 'sticker', ignore: true }));
    await rig.drain();
    for (const id of ['om_i1', 'om_i2', 'om_i3']) {
      assert.equal(rig.db.getMessage(id).status, 'ignored', id);
    }
    assert.equal(rig.api.calls.length, 0);
  });

  // 2026-09-21 真踩到：群里每开一次视频会议就推一张「（空消息）」卡片给主人。
  test('既没正文又没附件的消息不转发', async () => {
    rig.handleEvent(inbound({
      message_id: 'om_empty', chat_type: 'group', chat_id: 'oc_group',
      msg_type: 'video_chat', text: null, content: {}, attachments: [],
    }));
    await rig.drain();
    assert.equal(rig.db.getMessage('om_empty').status, 'ignored');
    assert.equal(sent(rig.api, 'sendCard').length, 0);
  });

  test('轮询拉回来的群历史只归档不转发', async () => {
    // 群里机器人只收得到 @ 它的消息，所以「实时来的」才该转；
    // 轮询拉回来的是群里所有人说的话，全转会把主人淹掉
    rig.handleEvent(inbound({ message_id: 'om_g1', chat_type: 'group', chat_id: 'oc_group', transport: 'poll' }));
    await rig.drain();
    assert.equal(rig.db.getMessage('om_g1').status, 'ignored');
    assert.equal(sent(rig.api, 'sendCard').length, 0);
  });

  test('出站失败会退避重试，达到上限才定格 failed', async () => {
    rig.outbox.queue({
      target: { type: 'open_id', id: TEACHER },
      msgType: 'text', payload: { text: 'x' }, purpose: 'manual',
    });
    rig.api.failNext('sendText', new Error('飞书 230001'));
    await rig.outbox.tick();
    const row = rig.db.raw.prepare('SELECT * FROM outbox WHERE id = 1').get();
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 1);
    assert.ok(row.next_at > Date.now(), '要顺延到将来');
    // 到期后能再被捞起并成功
    await rig.outbox.tick({ now: row.next_at });
    assert.equal(rig.db.raw.prepare('SELECT status FROM outbox WHERE id = 1').get().status, 'sent');
  });
});
