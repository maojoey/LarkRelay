// 看门狗。Docker 的 healthcheck 判 unhealthy **不会**自动重启容器，
// 所以真正的重启决策在这里：该死就 exit(1)，交给 restart: unless-stopped 拉起来。
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// 按告警种类各自冷却。**不能共用一个冷却**：否则一条连接告警会把「用户身份失效」
// 这种更要紧的提醒一起压掉，用户就永远收不到。
const COOLDOWN = {
  ws: HOUR,
  poll: HOUR,
  split: 6 * HOUR,
  user_token_dead: 6 * HOUR,   // 已经坏了，每 6 小时提醒一次直到处理
  reauth_due: DAY,             // 还没坏，每天提醒一次就够
  archive: 6 * HOUR,
};

export function createWatchdog({ config, log, health, notify, userToken, exit = (c) => process.exit(c) }) {
  const wd = config.watchdog ?? {};
  const disconnectedExitMs = (wd.disconnected_exit_sec ?? 180) * 1000;
  const defaultCooldownMs = (wd.alert_cooldown_sec ?? 3600) * 1000;
  let disconnectedSince = null;
  const lastAlertAt = new Map();

  async function alert(kind, text, { now = Date.now() } = {}) {
    const cd = COOLDOWN[kind] ?? defaultCooldownMs;
    if (now - (lastAlertAt.get(kind) ?? 0) < cd) return false;
    lastAlertAt.set(kind, now);
    // 告警发不出去不能阻塞退出——多半正是因为飞书连不上才要告警
    try { await notify?.(text); } catch (e) { log.warn('告警发送失败', { kind, err: e.message }); }
    return true;
  }

  /**
   * 用户身份的健康：**这条线坏了是静默的**——机器人照常收发，只有「别人私聊你本人」
   * 那半边悄悄停了归档，看日志才发现。所以必须主动发消息提醒，不能只写日志。
   */
  async function checkUserIdentity(now) {
    if (!userToken) return;
    const u = userToken.status();
    if (u.reason === 'never_authorized') return;   // 还没开始用，不算故障

    if (!u.authorized || u.dead) {
      await alert('user_token_dead',
        `⚠ 用户身份已失效（${u.dead ?? '未知原因'}）。`
        + `现在「别人私聊你本人」的消息**不再被归档**，机器人那半边不受影响。`
        + `跑 relay auth 重新授权即可恢复。`, { now });
      return;
    }
    if (u.reauth_warning) {
      await alert('reauth_due',
        `提醒：用户身份授权还有 ${u.reauth_due_in_days} 天到期（飞书规定满 365 天必须人工重新授权一次，`
        + `刷新再勤也推不掉）。到期前跑一次 relay auth 就行；不处理的话到期当天会静默停止归档。`, { now });
    }
  }

  async function checkArchive(now, s) {
    if ((s.archiveFailStreak ?? 0) < 3) return;
    await alert('archive',
      `⚠ 归档线连续失败 ${s.archiveFailStreak} 次：${s.archiveLastError ?? '未知'}。`
      + `「别人私聊你本人」的消息可能正在漏。`, { now });
  }

  // 返回该不该退出，便于测试；定时器版本见 start()
  async function check({ now = Date.now() } = {}) {
    const s = health.get();

    // **必须放在所有判死分支之前。** 判死分支会 return，放后面的话
    // 「连接挂了」会顺手把「用户身份失效」这类提醒一起压掉——而后者恰恰是静默的，
    // 用户只能靠这条提醒知道。一个故障不该掩盖另一个通知。
    await checkUserIdentity(now);
    await checkArchive(now, s);

    if (s.wsState === 'failed') {
      await alert('ws', 'LarkRelay：长连接进入 failed，准备重启进程', { now });
      log.error('看门狗判死：ws failed');
      return true;
    }

    if (s.wsState === 'connected' || s.wsState === 'disabled') {
      disconnectedSince = null;
    } else {
      disconnectedSince ??= now;
      if (now - disconnectedSince > disconnectedExitMs) {
        await alert('ws', 'LarkRelay：长连接持续断开超过阈值，准备重启进程', { now });
        log.error('看门狗判死：ws 长时间未连上', { ms: now - disconnectedSince });
        return true;
      }
    }

    if (s.pollFailStreak >= 3) {
      await alert('poll', 'LarkRelay：对账连续 3 次失败，准备重启进程', { now });
      log.error('看门狗判死：对账连续失败', { streak: s.pollFailStreak });
      return true;
    }

    if (s.splitSuspect) {
      await alert('split', 'LarkRelay：长连接正常却仍在漏消息，疑似有第二个消费者在抢同一应用的事件。'
        + '请检查有没有别处跑了 lark-cli event consume。', { now });
    }
    return false;
  }

  let timer = null;
  function start(intervalMs = 60_000) {
    timer = setInterval(() => {
      check().then((dead) => { if (dead) exit(1); }).catch(() => {});
    }, intervalMs);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { check, start, stop };
}
