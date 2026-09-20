import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.mjs';
import { createOAuth, normalizeTokens, HARD_REAUTH_MS } from '../src/lark/oauth.mjs';
import { createUserToken } from '../src/lark/user-token.mjs';

const silent = { info() {}, warn() {}, error() {} };
const DAY = 86_400_000;

function tokenJson({ access = 'at_1', refresh = 'rt_1', expires = 7200, refreshExpires = 604800 } = {}) {
  return {
    code: 0,
    access_token: access,
    expires_in: expires,
    refresh_token: refresh,
    refresh_token_expires_in: refreshExpires,
    token_type: 'Bearer',
    scope: 'im:message:readonly offline_access',
  };
}

// 假 fetch：记录每次请求体，按队列返回预置响应
function fakeFetch(queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { json: async () => next };
  };
  fn.calls = calls;
  return fn;
}

function rig({ queue = [], nowRef = { t: 1_700_000_000_000 } } = {}) {
  const db = openDb(':memory:');
  const f = fakeFetch(queue);
  const oauth = createOAuth({ appId: 'cli_xxxxxxxx', appSecret: 's3cret', log: silent, fetchImpl: f });
  const ut = createUserToken({ db, oauth, log: silent, now: () => nowRef.t });
  return { db, oauth, ut, fetch: f, nowRef };
}

describe('授权链接与令牌规范化', () => {
  test('授权链接带齐必要参数', () => {
    const { oauth } = rig();
    const u = new URL(oauth.authorizationUrl({
      redirectUri: 'https://example.com/lark/oauth/callback',
      scope: ['im:message:readonly', 'offline_access'],
      state: 'abc',
    }));
    assert.equal(u.searchParams.get('client_id'), 'cli_xxxxxxxx');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://example.com/lark/oauth/callback');
    assert.equal(u.searchParams.get('scope'), 'im:message:readonly offline_access');
    assert.equal(u.searchParams.get('state'), 'abc');
  });

  test('相对秒数换成绝对时间戳', () => {
    const t = 1_000_000;
    const n = normalizeTokens(tokenJson(), t);
    assert.equal(n.accessExpiresAt, t + 7200_000);
    assert.equal(n.refreshExpiresAt, t + 604800_000);
    assert.equal(n.refreshToken, 'rt_1');
  });

  test('凭据走请求体，不走 header', async () => {
    const { oauth, fetch: f } = rig({ queue: [tokenJson()] });
    await oauth.refresh('rt_0');
    assert.equal(f.calls[0].body.client_id, 'cli_xxxxxxxx');
    assert.equal(f.calls[0].body.client_secret, 's3cret');
    assert.equal(f.calls[0].body.grant_type, 'refresh_token');
    assert.equal(f.calls[0].body.refresh_token, 'rt_0');
  });

  test('网络失败与服务端拒绝要能区分开', async () => {
    const a = rig({ queue: [new Error('ECONNRESET')] });
    await assert.rejects(() => a.oauth.refresh('rt'), (e) => e.kind === 'network');
    const b = rig({ queue: [{ error: 'invalid_grant', error_description: 'expired' }] });
    await assert.rejects(() => b.oauth.refresh('rt'), (e) => e.kind === 'oauth' && e.oauthError === 'invalid_grant');
  });

  test('错误信息里不许出现 client_secret', async () => {
    const { oauth } = rig({ queue: [{ error: 'invalid_client' }] });
    await assert.rejects(() => oauth.refresh('rt'), (e) => !e.message.includes('s3cret'));
  });
});

describe('令牌生命周期', () => {
  let r;
  beforeEach(() => { r = rig(); });

  test('没授权过时状态清楚，取令牌直接报错', async () => {
    assert.deepEqual(r.ut.status(), { authorized: false, reason: 'never_authorized' });
    await assert.rejects(() => r.ut.getAccessToken(), /尚未授权/);
  });

  test('首次授权记下时间，并算出 365 天硬顶', () => {
    const t0 = r.nowRef.t;
    r.ut.saveInitial(normalizeTokens(tokenJson(), t0));
    const s = r.ut.status();
    assert.equal(s.authorized, true);
    assert.equal(s.first_authorized_at, t0);
    assert.equal(s.reauth_due_at, t0 + HARD_REAUTH_MS);
    assert.equal(s.reauth_due_in_days, 365);
    assert.equal(s.reauth_warning, false);
  });

  test('access 还没到期就直接用，不多打一次网络', async () => {
    r.ut.saveInitial(normalizeTokens(tokenJson(), r.nowRef.t));
    assert.equal(await r.ut.getAccessToken(), 'at_1');
    assert.equal(r.fetch.calls.length, 0);
  });

  test('快过期时提前刷新，并把新的 refresh_token 落盘', async () => {
    r.ut.saveInitial(normalizeTokens(tokenJson(), r.nowRef.t));
    r.nowRef.t += 7200_000 - 60_000;        // 只剩 1 分钟，小于提前量
    r.fetch.calls.length = 0;
    // 队列里放新票：飞书会换发一张新的 refresh_token
    const q = [tokenJson({ access: 'at_2', refresh: 'rt_2' })];
    r.oauth.refresh = createOAuth({
      appId: 'cli_xxxxxxxx', appSecret: 's3cret', log: silent, fetchImpl: fakeFetch(q),
    }).refresh;
    assert.equal(await r.ut.getAccessToken(), 'at_2');
    // 关键：旧票已作废，库里必须已经是新票
    assert.equal(JSON.parse(r.db.getKv('user_token')).refreshToken, 'rt_2');
  });

  test('刷新不重置授权时间（365 天硬顶推不掉）', async () => {
    const t0 = r.nowRef.t;
    r.ut.saveInitial(normalizeTokens(tokenJson(), t0));
    // 在 7 天窗口内刷新——这就是服务常态：每两小时换一次 access，顺带把 refresh 窗口滚起来
    r.nowRef.t += 3 * DAY;
    const q = [tokenJson({ access: 'at_2', refresh: 'rt_2' })];
    r.oauth.refresh = createOAuth({ appId: 'x', appSecret: 'y', log: silent, fetchImpl: fakeFetch(q) }).refresh;
    await r.ut.getAccessToken();
    const s = r.ut.status();
    assert.equal(s.first_authorized_at, t0, '硬顶从人工授权那刻算，刷新不重新计时');
    assert.equal(s.reauth_due_in_days, 362, '刷了一次，离硬顶只会更近，不会更远');
  });

  test('重新人工授权会重置 365 天硬顶', () => {
    const t0 = r.nowRef.t;
    r.ut.saveInitial(normalizeTokens(tokenJson(), t0));
    r.nowRef.t += 300 * DAY;
    r.ut.saveInitial(normalizeTokens(tokenJson({ access: 'at_new', refresh: 'rt_new' }), r.nowRef.t));
    assert.equal(r.ut.status().reauth_due_in_days, 365);
  });

  test('离硬顶 30 天内会给出警告标记', () => {
    const t0 = r.nowRef.t;
    r.ut.saveInitial(normalizeTokens(tokenJson(), t0));
    r.nowRef.t += 340 * DAY;
    assert.equal(r.ut.status().reauth_warning, true);
  });

  test('并发取令牌只刷新一次', async () => {
    r.ut.saveInitial(normalizeTokens(tokenJson(), r.nowRef.t));
    r.nowRef.t += 7200_000;                  // 已过期
    let hits = 0;
    const q = [tokenJson({ access: 'at_2' }), tokenJson({ access: 'at_3' })];
    const f = fakeFetch(q);
    r.oauth.refresh = createOAuth({
      appId: 'x', appSecret: 'y', log: silent,
      fetchImpl: async (...a) => { hits += 1; return f(...a); },
    }).refresh;
    const got = await Promise.all([r.ut.getAccessToken(), r.ut.getAccessToken(), r.ut.getAccessToken()]);
    assert.equal(hits, 1, '三个并发只能刷一次，否则会把自己的票刷废');
    assert.deepEqual(got, ['at_2', 'at_2', 'at_2']);
  });

  test('refresh_token 过期 → 判死，且说得清要重新授权', async () => {
    r.ut.saveInitial(normalizeTokens(tokenJson({ refreshExpires: 60 }), r.nowRef.t));
    r.nowRef.t += 7200_000;
    await assert.rejects(() => r.ut.getAccessToken(), /过期|重新授权/);
    const s = r.ut.status();
    assert.equal(s.authorized, false);
    assert.match(s.dead, /过期/);
  });

  test('服务端拒绝 → 判死；网络抖动 → 不判死，还能再试', async () => {
    r.ut.saveInitial(normalizeTokens(tokenJson(), r.nowRef.t));
    r.nowRef.t += 7200_000;
    r.oauth.refresh = createOAuth({
      appId: 'x', appSecret: 'y', log: silent, fetchImpl: fakeFetch([new Error('ETIMEDOUT')]),
    }).refresh;
    await assert.rejects(() => r.ut.getAccessToken());
    assert.equal(r.ut.status().dead, null, '网络问题不该把令牌判死');

    r.oauth.refresh = createOAuth({
      appId: 'x', appSecret: 'y', log: silent, fetchImpl: fakeFetch([{ error: 'invalid_grant' }]),
    }).refresh;
    await assert.rejects(() => r.ut.getAccessToken());
    assert.equal(r.ut.status().dead, 'invalid_grant');
    await assert.rejects(() => r.ut.getAccessToken(), /已失效/);
  });

  test('没拿到 refresh_token 时仍可用两小时，但状态要能看出来', async () => {
    const j = tokenJson();
    delete j.refresh_token;            // 默认参数会把 undefined 填回默认值，必须真的删掉
    delete j.refresh_token_expires_in; // 现实成因：scope 里漏了 offline_access
    r.ut.saveInitial(normalizeTokens(j, r.nowRef.t));
    const s = r.ut.status();
    assert.equal(s.authorized, true);
    assert.equal(s.refresh_expires_at, null);
    // access 一过期就彻底没救，只能重新授权
    r.nowRef.t += 7200_000;
    await assert.rejects(() => r.ut.getAccessToken(), /重新授权/);
  });
});
