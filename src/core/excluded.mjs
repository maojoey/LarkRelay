// 「这个会话不归档」——与 ignored 是两件事。
// ignored = 入库但不转发（群里没 @ 我的那些，用户 2026-09-21 定）。
// 排除 = 连行都不写：有些群全是应用推的卡片，归档它们只会把库撑大、
// 把真正的人类消息淹掉（实测 AI汇报群 一个群占了全库 69%，人类消息 0 条）。
//
// 判断必须同时管住两条入口：实时事件走 handleEvent，机器人/应用发的走 pull 的
// insertOutbound——后者绕开 handleEvent，那 354 张卡片就是从这条路进来的。
export function createIsExcluded(config) {
  const set = new Set(config.archive?.exclude_chats ?? []);
  return (chatId) => set.has(chatId);
}
