// 用户身份授权。
//
// **默认不需要对公网开任何口。** 授权码在浏览器跳转时就明文躺在地址栏里，所以重定向地址
// 可以登记成 http://localhost:<port>/... —— 跳转落到操作者自己的机器上（没东西监听、
// 浏览器报个错都无所谓），把地址栏整条粘回来即可（complete）。全程没有第三方碰得到授权码，
// 而且授权码没有 app_secret 也换不出令牌。
//
// 想要自动化的话再把 callback 挂到公网（那就是唯一对外的口）；两条路共用同一套校验。
// 三道校验缺一不可，否则任何人都能用自己的账号走完流程、把主人的令牌顶掉：
//   1. 必须先由主人（带 admin token）调 start 起一个流程，才会生成 state
//   2. 回调里的 state 必须命中且未过期，用完即删（一次性）
//   3. 换到令牌后回查「这个令牌属于谁」，**open_id 必须是配置里的主人**，否则拒收
// 授权码本身泄漏了也没用：没有 app_secret 换不出令牌。
import { randomBytes } from 'node:crypto';

const STATE_KEY = 'oauth_pending_state';
// 30 分钟：提醒是异步看到的（手机上过一会儿才点），10 分钟经常不够，
// 过期又要重来一轮。state 本身泄漏无用——没有对应的授权码换不出令牌。
const STATE_TTL_MS = 30 * 60_000;

// 用户身份要用到的 scope。
// **offline_access 缺了就拿不到 refresh_token**，令牌两小时后即死、每两小时要人工扫一次码。
// **im:message.send_as_user 是唯一的写权限**：回传要以主人本人的名义发就必须有它。
// 只想做只读归档（回传由机器人转达）的话，把它从这个列表里删掉，
// 出站会自动降级成机器人发并在正文前加转达前缀——功能不断，只是落款不同。
// **这张表就是授权链接里请求的 scope，拿到的令牌只会有这里列出的东西。**
// 在开发者后台开通权限只是「允许申请」，不申请照样拿不到——2026-09-21 踩过：
// 后台开好了建群权限，但这张表没改，重新授权后令牌里依然没有，白授权一次。
// 可用 config.oauth.scopes 覆盖，改完不用重新部署。
export const DEFAULT_USER_SCOPES = [
  // 读自己的会话与消息
  'im:message:readonly',
  'im:message.p2p_msg:get_as_user',
  'im:message.group_msg:get_as_user',
  'im:chat:read',
  'im:chat.members:read',
  'contact:user.base:readonly',
  // 以本人名义发消息。**这两条必须一起给**，只给 send_as_user 发不出去
  // （99991679，私聊群聊都一样，从上线到 2026-09-21 一次都没成功过）。
  //
  // 飞书那句报错列了三个候选：[im:message:send, im:message, im:message:send_as_bot]，
  // 但**只有 `im:message` 在后台的「用户身份权限」表里真实存在**（免审，名称
  // 「获取与发送单聊、群组消息」），另外两个是应用身份权限。
  // **别照错误文案抄名字**——加过 `im:message:send`，授权页当场 20027 挂掉，
  // 连归档要用的那次重新授权都做不成。以后台列表为准，不以错误文案为准。
  //
  // 另注：后台勾选权限和这张表要**同时**做。只勾不申请拿不到；
  // 只申请没勾就是 20027。改这里之前先确认后台已经开通并发布。
  'im:message.send_as_user',
  'im:message',
  // 以本人名义建群与管群：这样建出来的群**群主直接就是本人**，不用事后转让
  'im:chat:create_by_user',
  'im:chat:update',
  'im:chat.members:write_only',
  'im:chat.managers:write_only',
  // 缺了它就拿不到 refresh_token，令牌两小时后即死
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

  /**
   * 从粘回来的整条跳转地址里把授权码抠出来，走同一套校验。
   * 这是默认路径：不需要公网回调，操作者自己复制地址栏即可。
   */
  async function complete({ callback_url: callbackUrl, code, state }) {
    if (callbackUrl) {
      let u;
      try { u = new URL(callbackUrl); } catch { throw new Error('这不是一条完整的地址，请把浏览器地址栏整条复制过来'); }
      const q = Object.fromEntries(u.searchParams);
      if (!q.code && !q.error) throw new Error('这条地址里没有授权码，确认是同意之后跳转到的那一条');
      return callback(q);
    }
    return callback({ code, state });
  }

  /** 换令牌并落盘。公网回调与粘贴地址两条路都走这里。 */
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
      // 把看到的 open_id 原样回给调用方（这条路径要 admin token，不是公开的）。
      // **最常见的原因不是「授权错了账号」，而是 open_id 按应用隔离**：
      // 同一个人在每个应用下的 open_id 都不同，从别的应用抄来的值在这里必然对不上。
      // 不把实际值报出来的话，这个错根本没法自查——踩过一次，别再省这一句。
      throw new Error(
        `授权账号与配置里的主人不是同一个人，已拒绝。`
        + `配置里写的是 ${config.teacher_open_id}，实际授权的是 ${who.openId}。`
        + `注意 open_id 是**按应用隔离**的：同一个人在不同应用下 open_id 不同，`
        + `不能从别的应用抄。确认是本人的话，把 config.teacher_open_id 改成上面这个实际值。`,
      );
    }

    userToken.saveInitial(tokens);
    log?.info('用户身份授权完成', { name: who.name });
    return { ok: true, name: who.name };
  }

  return { start, callback, complete, scopes };
}

// 日志里不打完整 open_id：它不是密钥，但也没必要全量落进日志和备份
const mask = (id) => (id ? `${String(id).slice(0, 6)}…` : 'null');
