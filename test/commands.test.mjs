// 对话内指令是「陌生人能触达的代码路径」，所以每条边界都要钉：
// 只认主人、只认私聊、只认这两个形状。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createCommands } from '../src/core/commands.mjs';

const silent = { info() {}, warn() {}, error() {} };

function rig({ completeResult = { ok: true, name: '某人' }, completeError = null, startError = null } = {}) {
  const completed = [];
  const oauthRoutes = {
    start: () => {
      if (startError) throw new Error(startError);
      return { url: 'https://accounts.example/authorize?state=s1', expires_in_sec: 1800 };
    },
    complete: async (arg) => {
      completed.push(arg);
      if (completeError) throw new Error(completeError);
      return completeResult;
    },
  };
  return { commands: createCommands({ oauthRoutes, log: silent }), completed };
}

const msg = (over = {}) => ({ chat_type: 'p2p', text: '', ...over });

describe('要授权链接', () => {
  let r;
  beforeEach(() => { r = rig(); });

  for (const word of ['授权', '重新授权', 'auth', 'AUTH', ' 授权 ']) {
    test(`「${word}」会回一条链接`, async () => {
      const out = await r.commands.tryHandle(msg({ text: word }), { isOwner: true });
      assert.ok(out, '应被识别为指令');
      assert.match(out.reply, /https:\/\/accounts\.example/);
      assert.match(out.reply, /30 分钟内有效/);
      assert.match(out.reply, /地址栏整条/);
    });
  }

  test('生成失败时说人话，不抛', async () => {
    const r2 = rig({ startError: '没配 redirect_uri' });
    const out = await r2.commands.tryHandle(msg({ text: '授权' }), { isOwner: true });
    assert.match(out.reply, /没配 redirect_uri/);
  });

  test('「授权一下学生名单」这类不是指令，按普通消息走', async () => {
    assert.equal(await r.commands.tryHandle(msg({ text: '授权一下学生名单' }), { isOwner: true }), null);
  });
});

describe('粘回跳转地址完成授权', () => {
  let r;
  beforeEach(() => { r = rig(); });

  test('识别地址并完成授权', async () => {
    const url = 'http://localhost:8310/lark/oauth/callback?code=abc123&state=s1';
    const out = await r.commands.tryHandle(msg({ text: url }), { isOwner: true });
    assert.match(out.reply, /授权成功/);
    assert.equal(r.completed[0].callback_url, url);
  });

  test('地址前后带了别的字也能认出来', async () => {
    const out = await r.commands.tryHandle(
      msg({ text: '喏 http://localhost:8310/lark/oauth/callback?code=abc&state=s1 这个' }),
      { isOwner: true },
    );
    assert.match(out.reply, /授权成功/);
    assert.match(r.completed[0].callback_url, /code=abc&state=s1/);
  });

  test('失败时告诉他怎么重来，而不是只报错', async () => {
    const r2 = rig({ completeError: 'state 校验失败：请重新从 start 发起授权' });
    const out = await r2.commands.tryHandle(
      msg({ text: 'http://x/cb?code=a&state=b' }), { isOwner: true },
    );
    assert.match(out.reply, /state 校验失败/);
    assert.match(out.reply, /发「授权」/, '要给出重来的办法');
  });

  test('不带 code 的普通链接不当授权处理', async () => {
    assert.equal(
      await r.commands.tryHandle(msg({ text: '看看这个 https://example.com/a?b=1' }), { isOwner: true }),
      null,
    );
    assert.equal(r.completed.length, 0);
  });
});

describe('边界：谁能用、在哪能用', () => {
  let r;
  beforeEach(() => { r = rig(); });

  test('**不是主人发的一律不处理**，哪怕内容完全一样', async () => {
    const url = 'http://localhost:8310/lark/oauth/callback?code=abc&state=s1';
    assert.equal(await r.commands.tryHandle(msg({ text: url }), { isOwner: false }), null);
    assert.equal(await r.commands.tryHandle(msg({ text: '授权' }), { isOwner: false }), null);
    assert.equal(r.completed.length, 0, '别人贴一条链接绝不能触发授权');
  });

  test('群里不处理，只认私聊', async () => {
    const out = await r.commands.tryHandle(
      msg({ chat_type: 'group', text: '授权' }), { isOwner: true },
    );
    assert.equal(out, null);
  });

  test('空消息与非文本不处理', async () => {
    assert.equal(await r.commands.tryHandle(msg({ text: '   ' }), { isOwner: true }), null);
    assert.equal(await r.commands.tryHandle(msg({ text: null }), { isOwner: true }), null);
  });
});
