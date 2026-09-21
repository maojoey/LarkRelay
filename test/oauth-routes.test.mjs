import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.mjs';
import { createFakeApi } from '../src/lark/fake.mjs';
import { createOAuthRoutes, DEFAULT_USER_SCOPES } from '../src/core/oauth-routes.mjs';

const OWNER = 'ou_owner';
const silent = { info() {}, warn() {}, error() {} };

// 注意：不能用默认参数，传 undefined 会落回默认值，「没配」这种用例就测不出来
function rig(opts = {}) {
  const ownerId = 'ownerId' in opts ? opts.ownerId : OWNER;
  const redirectUri = 'redirectUri' in opts ? opts.redirectUri : 'https://example.com/lark/oauth/callback';
  const db = openDb(':memory:');
  const api = createFakeApi({ log: silent });
  const saved = [];
  const userToken = { saveInitial: (t) => { saved.push(t); return { authorized: true }; } };
  const exchanges = [];
  const oauth = {
    authorizationUrl: (o) => `https://accounts.example/authorize?state=${o.state}&scope=${encodeURIComponent(o.scope.join(' '))}`,
    exchangeCode: async (o) => { exchanges.push(o); return { accessToken: 'uat_new', refreshToken: 'rt_new' }; },
  };
  const routes = createOAuthRoutes({
    db, oauth, api, userToken, log: silent,
    config: { teacher_open_id: ownerId, oauth: { redirect_uri: redirectUri } },
  });
  return { db, api, routes, saved, exchanges };
}

const stateOf = (url) => new URL(url).searchParams.get('state');

describe('授权发起', () => {
  test('生成链接并带上必要的 scope', () => {
    const { routes } = rig();
    const { url } = routes.start();
    assert.ok(stateOf(url));
    const scope = new URL(url).searchParams.get('scope');
    // 没有 offline_access 就拿不到 refresh_token，令牌两小时后就死
    assert.ok(scope.includes('offline_access'));
    assert.ok(scope.includes('im:message.p2p_msg:get_as_user'));
    // 回传要以主人本人名义发就必须有这个写权限，漏了会在上线当天才发现
    assert.ok(scope.includes('im:message.send_as_user'));
    // 后台开通 ≠ 拿得到：不在这张表里就不会被申请，令牌里也就没有。踩过一次。
    assert.ok(scope.includes('im:chat:create_by_user'), '以本人名义建群的权限必须申请');
    assert.deepEqual(routes.scopes, DEFAULT_USER_SCOPES);
  });

  test('没配回调地址就直说，不生成半截链接', () => {
    const { routes } = rig({ redirectUri: undefined });
    assert.throws(() => routes.start(), /redirect_uri/);
  });
});

describe('授权回调的三道校验', () => {
  let r;
  beforeEach(() => { r = rig(); });

  test('正常流程：换到令牌、校验身份、落盘', async () => {
    const { url } = r.routes.start();
    const res = await r.routes.callback({ code: 'code_1', state: stateOf(url) });
    assert.equal(res.ok, true);
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].accessToken, 'uat_new');
    assert.equal(r.exchanges[0].redirectUri, 'https://example.com/lark/oauth/callback');
  });

  test('没先 start 就来回调 → 拒绝', async () => {
    await assert.rejects(() => r.routes.callback({ code: 'c', state: 'whatever' }), /state/);
    assert.equal(r.saved.length, 0);
  });

  test('state 对不上 → 拒绝', async () => {
    r.routes.start();
    await assert.rejects(() => r.routes.callback({ code: 'c', state: 'forged' }), /state/);
    assert.equal(r.saved.length, 0);
  });

  test('state 是一次性的，重放会被拒', async () => {
    const { url } = r.routes.start();
    const st = stateOf(url);
    await r.routes.callback({ code: 'c1', state: st });
    await assert.rejects(() => r.routes.callback({ code: 'c2', state: st }), /state/);
    assert.equal(r.saved.length, 1, '重放不该再存一次');
  });

  test('别人拿自己账号走完流程 → 身份不符，拒收', async () => {
    r.api.userInfo = { openId: 'ou_someone_else', name: '路人' };
    const { url } = r.routes.start();
    await assert.rejects(
      () => r.routes.callback({ code: 'c', state: stateOf(url) }),
      /不是同一个人/,
    );
    assert.equal(r.saved.length, 0, '令牌绝不能被顶掉');
  });

  test('用户在飞书页面点了拒绝 → 明确报出来', async () => {
    const { url } = r.routes.start();
    await assert.rejects(
      () => r.routes.callback({ error: 'access_denied', state: stateOf(url) }),
      /授权被拒绝/,
    );
  });

  test('回调里没带授权码 → 拒绝', async () => {
    const { url } = r.routes.start();
    await assert.rejects(() => r.routes.callback({ state: stateOf(url) }), /授权码/);
  });

  test('粘贴整条跳转地址也能完成授权（默认路径，不需要公网回调）', async () => {
    const { url } = r.routes.start();
    const st = stateOf(url);
    const pasted = `http://localhost:8310/lark/oauth/callback?code=code_9&state=${st}`;
    const res = await r.routes.complete({ callback_url: pasted });
    assert.equal(res.ok, true);
    assert.equal(r.saved[0].accessToken, 'uat_new');
  });

  test('粘的不是地址 / 地址里没授权码 → 说人话', async () => {
    r.routes.start();
    await assert.rejects(() => r.routes.complete({ callback_url: '我随便打了几个字' }), /完整的地址/);
    r.routes.start();
    await assert.rejects(
      () => r.routes.complete({ callback_url: 'http://localhost:8310/lark/oauth/callback' }),
      /没有授权码/,
    );
  });

  test('粘贴路径同样过三道校验：state 伪造要被拒', async () => {
    r.routes.start();
    await assert.rejects(
      () => r.routes.complete({ callback_url: 'http://localhost:8310/cb?code=c&state=forged' }),
      /state/,
    );
    assert.equal(r.saved.length, 0);
  });

  test('粘贴路径同样核对身份：别人的账号要被拒', async () => {
    r.api.userInfo = { openId: 'ou_someone_else', name: '路人' };
    const { url } = r.routes.start();
    await assert.rejects(
      () => r.routes.complete({ callback_url: `http://localhost:8310/cb?code=c&state=${stateOf(url)}` }),
      /不是同一个人/,
    );
    assert.equal(r.saved.length, 0);
  });

  test('没配主人 open_id 时不做身份校验（但会照常落盘）', async () => {
    const r2 = rig({ ownerId: undefined });
    r2.api.userInfo = { openId: 'ou_anyone', name: '谁都行' };
    const { url } = r2.routes.start();
    const res = await r2.routes.callback({ code: 'c', state: stateOf(url) });
    assert.equal(res.ok, true);
  });
});
