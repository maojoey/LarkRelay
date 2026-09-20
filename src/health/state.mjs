// 进程内健康状态单例：各模块写，/healthz 与看门狗读。
// 「连着但收不到」是长连接的典型故障，所以这里同时记连接态与最后一次真正收到事件的时间。
const state = {
  startedAt: Date.now(),
  wsState: 'init',          // init / connecting / connected / reconnecting / failed / disabled
  wsLastConnect: null,
  lastEventAt: null,        // 最后一次通过 ws/webhook 收到事件
  lastPollAt: null,         // 最后一次对账成功
  lastPollMissed: 0,
  pollFailStreak: 0,
  missed24h: 0,
  splitSuspect: false,      // 对账发现 ws 明明 connected 却漏了消息 → 疑似有人抢同一应用的事件
};

export const health = {
  get: () => ({ ...state }),
  set(patch) { Object.assign(state, patch); },
  markEvent() { state.lastEventAt = Date.now(); },
  addMissed(n) { state.missed24h += n; state.lastPollMissed = n; },
};
