// 用户身份授权的两个 HTTP 端点。
//
// 回调地址**必须公开可达**（飞书要能重定向到它），所以它是整个服务唯一对外开的口。
// 三道校验缺一不可，否则任何人都能用自己的账号走完流程、把主人的令牌顶掉：
//   1. 必须先由主人（带 admin token）调 start 起一个流程，才会生成 state
//   2. 回调里的 state 必须命中且未过期，用完即删（一次性）
//   3. 换到令牌后回查「这个令牌属于谁」，**open_id 必须是配置里的主人**，否则拒收
// 授权码本身泄漏了也没用：没有 app_secret 换不出令牌。
import { randomBytes } from 'node:crypto';

const STATE_KEY = 'oauth_pending_state';
const STATE_TTL_MS = 10 * 60_000;

// 用户身份要用到的 scope。
// **offline_access 缺了就拿不到 refresh_token**，令牌两小时后即死、每两小时要人工扫一次码。
// **im:message.send_as_user 是唯一的写权限**：回传要以主人本人的名义发就必须有它。
// 只想做只读归档（回传由机器人转达）的话，把它从这个列表里删掉，
// 出站会自动降级成机器人发并在正文前加转达前缀——功能不断，只是落款不同。
export const DEFAULT_USER_SCOPES = [
  'im:message:readonly',
  'im:message.p2p_msg:get_as_user',
  'im:message.group_msg:get_as_user',
  'im:chat:read',
  'contact:user.base:readonly',
  'im:message.send_as_user',
  'offline_access',
];

export function createOAuthRoutes({ db, oauth, api, userToken, config, log }) {
  const redirectUri = config.oauth?.redirect_uri;
  const scopes = config.oauth?.scopes ?? DEFAULT_USER_SCOPES;

  /** 主人发起授权：返回一个让他在浏览器里打开的链接。 */
  function start() {
    if (!redirectUri) throw new Error('没配 oauth.redirect_uri，先在配置和开发者后台的安全设置里都填上');
    const state = randomBytes(16).toString('hex');
    db.setKv(STATE_KEY, JSON.stringify({ state, expiresAt: Date.now() + STATE_TTL_MS }));
    const url = oauth.authorizationUrl({ redirectUri, scope: scopes, state });
    log?.info('已生成授权链接，等待主人在浏览器里同意');
    return { url, expires_in_sec: STATE_TTL_MS / 1000 };
  }

  function takePendingState() {
    const raw = db.getKv(STATE_KEY);
    if (!raw) return null;
    db.setKv(STATE_KEY, '');   // 一次性：无论成败都作废，防重放
    try {
      const p = JSON.parse(raw);
      return p.expiresAt > Date.now() ? p.state : null;
    } catch { return null; }
  }

  /** 飞书回调：拿授权码换令牌并落盘。返回给浏览器看的一句话。 */
  async function callback({ code, state, error }) {
    if (error) throw new Error(`授权被拒绝：${error}`);
    if (!code) throw new Error('回调里没有授权码');

    const expect = takePendingState();
    if (!expect || expect !== state) {
      log?.warn('授权回调的 state 对不上，已拒绝');
      throw new Error('state 校验失败：请重新从 start 发起授权');
    }

    const tokens = await oauth.exchangeCode({ code, redirectUri });

    // 第三道：这个令牌到底是谁的
    const who = await api.getUserInfo({ asUser: tokens.accessToken });
    if (config.teacher_open_id && who.openId !== config.teacher_open_id) {
      log?.error('授权账号与配置的主人不符，已拒绝', { got: mask(who.openId) });
      throw new Error('授权账号与配置里的主人不是同一个人，已拒绝');
    }

    userToken.saveInitial(tokens);
    log?.info('用户身份授权完成', { name: who.name });
    return { ok: true, name: who.name };
  }

  return { start, callback, scopes };
}

// 日志里不打完整 open_id：它不是密钥，但也没必要全量落进日志和备份
const mask = (id) => (id ? `${String(id).slice(0, 6)}…` : 'null');
