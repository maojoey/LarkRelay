// 主人在飞书私聊里能直接完成的几件事。**只认主人、只认私聊、只认下面这几个形状**，
// 不是一个通用命令系统——收到的消息是不可信输入，能触发的动作越少越好。
//
// 存在的理由：用户身份的令牌会过期（飞书规定满 365 天必须人工重新授权），
// 而提醒如果只说「去服务器敲个命令」，实际上等于没有提醒——人在手机上看到提醒，
// 手边没有终端。所以整个重新授权的闭环必须能在这个对话里走完：
//   机器人发提醒（带链接）→ 点链接同意 → 把地址栏粘回这个对话 → 机器人回「授权成功」。

// 同意后浏览器跳转到的那条地址，形如 …/callback?code=xxx&state=yyy
const CALLBACK_RE = /https?:\/\/\S*[?&]code=[^\s&]+\S*/i;
const ASK_AUTH_RE = /^\s*(授权|重新授权|auth|reauth)\s*$/i;

export function createCommands({ oauthRoutes, log }) {
  /**
   * @returns {null | {reply: string}} null 表示这条不是命令，按普通消息继续处理
   */
  async function tryHandle(msg, { isOwner }) {
    if (!isOwner || msg.chat_type !== 'p2p') return null;
    const text = (msg.text ?? '').trim();
    if (!text) return null;

    if (ASK_AUTH_RE.test(text)) {
      if (!oauthRoutes) return { reply: '没有配置用户身份授权（缺 oauth.redirect_uri）。' };
      try {
        const { url, expires_in_sec: ttl } = oauthRoutes.start();
        return {
          reply: `用你本人的账号打开下面这条链接点同意（${Math.round(ttl / 60)} 分钟内有效）：\n\n${url}\n\n`
            + '同意后浏览器会跳到一个打不开的地址，那是正常的——'
            + '把**地址栏整条**复制、直接发回这个对话即可，我来完成剩下的。',
        };
      } catch (e) {
        return { reply: `生成授权链接失败：${e.message}` };
      }
    }

    const m = CALLBACK_RE.exec(text);
    if (m) {
      if (!oauthRoutes) return { reply: '没有配置用户身份授权，这条链接用不上。' };
      try {
        const r = await oauthRoutes.complete({ callback_url: m[0] });
        log?.info('主人在对话里完成了用户身份授权');
        return { reply: `授权成功${r.name ? `（${r.name}）` : ''}。「别人私聊你本人」的消息现在会继续归档。` };
      } catch (e) {
        return { reply: `授权没成功：${e.message}\n\n发「授权」两个字可以重新拿一条链接。` };
      }
    }

    return null;
  }

  return { tryHandle };
}
