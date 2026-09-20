// 看门狗。Docker 的 healthcheck 判 unhealthy **不会**自动重启容器，
// 所以真正的重启决策在这里：该死就 exit(1)，交给 restart: unless-stopped 拉起来。
export function createWatchdog({ config, log, health, notify, exit = (c) => process.exit(c) }) {
  const wd = config.watchdog ?? {};
  const disconnectedExitMs = (wd.disconnected_exit_sec ?? 180) * 1000;
  const cooldownMs = (wd.alert_cooldown_sec ?? 3600) * 1000;
  let disconnectedSince = null;
  let lastAlertAt = 0;

  async function alert(text) {
    const now = Date.now();
    if (now - lastAlertAt < cooldownMs) return;
    lastAlertAt = now;
    // 告警发不出去不能阻塞退出——多半正是因为飞书连不上才要告警
    try { await notify?.(text); } catch (e) { log.warn('告警发送失败', { err: e.message }); }
  }

  // 返回该不该退出，便于测试；定时器版本见 start()
  async function check({ now = Date.now() } = {}) {
    const s = health.get();

    if (s.wsState === 'failed') {
      await alert('LarkRelay：长连接进入 failed，准备重启进程');
      log.error('看门狗判死：ws failed');
      return true;
    }

    if (s.wsState === 'connected' || s.wsState === 'disabled') {
      disconnectedSince = null;
    } else {
      disconnectedSince ??= now;
      if (now - disconnectedSince > disconnectedExitMs) {
        await alert('LarkRelay：长连接持续断开超过阈值，准备重启进程');
        log.error('看门狗判死：ws 长时间未连上', { ms: now - disconnectedSince });
        return true;
      }
    }

    if (s.pollFailStreak >= 3) {
      await alert('LarkRelay：对账连续 3 次失败，准备重启进程');
      log.error('看门狗判死：对账连续失败', { streak: s.pollFailStreak });
      return true;
    }

    if (s.splitSuspect) {
      await alert('LarkRelay：长连接正常却仍在漏消息，疑似有第二个消费者在抢同一应用的事件。'
        + '请检查有没有别处跑了 lark-cli event consume。');
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
