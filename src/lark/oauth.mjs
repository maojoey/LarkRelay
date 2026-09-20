// 用户身份 OAuth：授权链接、用授权码换令牌、刷新令牌。
// 刻意不用 SDK：SDK 把 OAuth 埋在内部的 token manager 里，而我们需要**自己掌管 refresh_token 的落盘**
// （见下），借不上力，直接打 HTTP 反而清楚。
//
// 三条来自官方文档的硬事实，决定了这个模块的形状：
//   1. refresh_token **一次性**。换新令牌时会返回新的 refresh_token，原的立即失效。
//      → 拿到新值必须先落盘再用，且全局只能有一个写者，否则两处互相把对方的票作废。
//   2. refresh_token 自带 7 天窗口，每次刷新重新计时。
//      → 只要服务持续运行就能自动接力。
//   3. **从首次人工授权起满 365 天，必须重新走一遍浏览器授权**，再勤快刷新也推不掉。
//      → 必须记住首次授权时间并提前告警，否则会在无人值守时突然断档。
//
// 凭据走请求体（client_id / client_secret 明文塞 JSON），不是 Basic、也不是 Bearer。

const DEFAULT_TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
const DEFAULT_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';

// 授权满这么久就必须重新人工授权。官方定的，不是我们的策略。
export const HARD_REAUTH_MS = 365 * 24 * 3600 * 1000;

export function createOAuth({ appId, appSecret, tokenUrl = DEFAULT_TOKEN_URL, authorizeUrl = DEFAULT_AUTHORIZE_URL, log, fetchImpl = fetch }) {
  // 授权链接。authorizeUrl 做成可配置的：它是浏览器跳转地址、不是 API，
  // SDK 里没有收录，官方文档也改过版本，写死了万一对不上就得改代码。
  function authorizationUrl({ redirectUri, scope, state }) {
    const u = new URL(authorizeUrl);
    u.searchParams.set('client_id', appId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    if (scope) u.searchParams.set('scope', Array.isArray(scope) ? scope.join(' ') : scope);
    if (state) u.searchParams.set('state', state);
    return u.toString();
  }

  async function post(body, label) {
    let res; let json;
    try {
      res = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ client_id: appId, client_secret: appSecret, ...body }),
      });
      json = await res.json();
    } catch (e) {
      // 只透传 e.message：整个 error 对象可能带上请求体，那里面有 client_secret。
      // kind='network'：调用方据此判断「值得重试」，不要把令牌判死。
      throw Object.assign(new Error(`${label} 网络失败：${e.message}`), { kind: 'network' });
    }
    // 两种失败形状都见过：OAuth 风格的 error/error_description，和飞书风格的 code/msg
    if (json?.error || (json?.code && json.code !== 0)) {
      const what = json.error ?? `code=${json.code}`;
      const why = json.error_description ?? json.msg ?? '';
      log?.warn('oauth 失败', { label, what, why });
      // kind='oauth'：服务端明确拒绝，重试没用，令牌该判死、等人重新授权
      throw Object.assign(new Error(`${label} 失败：${what} ${why}`.trim()), { kind: 'oauth', oauthError: what });
    }
    if (!json?.access_token) throw new Error(`${label} 返回里没有 access_token`);
    return normalizeTokens(json);
  }

  const exchangeCode = ({ code, redirectUri, codeVerifier }) => post({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  }, '用授权码换令牌');

  const refresh = (refreshToken) => post({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, '刷新令牌');

  return { authorizationUrl, exchangeCode, refresh };
}

// 把飞书返回的相对秒数换成绝对毫秒时间戳，省得每个调用方自己算。
// refresh_token **仅在 scope 含 offline_access 时才返回**；没有它就只能活两小时。
export function normalizeTokens(json, now = Date.now()) {
  return {
    accessToken: json.access_token,
    accessExpiresAt: now + (Number(json.expires_in) || 0) * 1000,
    refreshToken: json.refresh_token ?? null,
    refreshExpiresAt: json.refresh_token_expires_in
      ? now + Number(json.refresh_token_expires_in) * 1000
      : null,
    scope: json.scope ?? null,
  };
}
