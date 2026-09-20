// 回复路由。**只认带 reply_to 的消息**——老师在私聊里堆着不同人的转发卡片，
// 裸打一行字无法判断说给谁听，猜错就是把话发给错的学生。裸消息一律当备忘，不回传。
export function createRouter({ db }) {
  // 老师回复的可能是转发卡片本身，也可能是紧随其后的附件消息；两者都登记在 routes 里。
  function resolve(replyTo) {
    if (!replyTo) return { ok: false, reason: 'no_reply_to' };
    const route = db.findRoute(replyTo);
    if (!route) return { ok: false, reason: 'unknown_target' };
    return { ok: true, route };
  }

  return { resolve };
}
