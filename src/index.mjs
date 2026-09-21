// 装配。所有接线都在这里，别的模块只认注入进来的依赖。
//
// RELAY_LIVE 门闩：不为 '1' 时用 fake api 且不建立任何长连接。
// 这是防止本机开发时误起第二个事件消费者——同一应用的多个长连接会分流，丢消息且极难查。
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { log } from './log.mjs';
import { openDb } from './db.mjs';
import { health } from './health/state.mjs';
import { createApi } from './lark/api.mjs';
import { createFakeApi } from './lark/fake.mjs';
import { createFiles } from './core/files.mjs';
import { createOutbox } from './core/outbox.mjs';
import { createRouter } from './core/router.mjs';
import { createWorker } from './core/worker.mjs';
import { createHandleEvent } from './core/handleEvent.mjs';
import { createReconcile } from './health/reconcile.mjs';
import { createArchiver } from './health/archiver.mjs';
import { createOAuth } from './lark/oauth.mjs';
import { createUserToken } from './lark/user-token.mjs';
import { createOAuthRoutes } from './core/oauth-routes.mjs';
import { createCommands } from './core/commands.mjs';
import { createWatchdog } from './health/watchdog.mjs';
import { createHttp } from './http.mjs';
import { createWsTransport } from './transport/ws.mjs';
import { createWebhookTransport } from './transport/webhook.mjs';

const WORKER_TICK_MS = 500;
const OUTBOX_TICK_MS = 500;

export async function boot({ env = process.env } = {}) {
  const config = loadConfig(env);
  for (const d of [config.paths.files, config.paths.outgoing]) await mkdir(d, { recursive: true });

  const db = openDb(config.paths.db);
  const api = config.live
    ? createApi({ appId: config.app_id, appSecret: config.secrets.app_secret, log })
    : createFakeApi({ log });
  if (!config.live) log.warn('RELAY_LIVE 未置 1：使用 fake api，不建立任何长连接');

  const files = createFiles({ config, log });
  // 用户身份要先于 outbox 建：回传以主人名义发，outbox 发送时要问它取令牌。
  // 令牌只在这一个进程里持有和刷新——refresh_token 一次性，两处各存一份会互相顶掉。
  const oauth = createOAuth({ appId: config.app_id, appSecret: config.secrets.app_secret, log });
  const userToken = createUserToken({ db, oauth, log });
  const outbox = createOutbox({ db, api, files, log, userToken });
  outbox.setOwnerTarget({ type: 'open_id', id: config.teacher_open_id });
  const router = createRouter({ db });


  let wakePending = false;
  const wake = () => { wakePending = true; };
  const handleEvent = createHandleEvent({ db, config, log, wake });

  const reconcile = createReconcile({ db, api, config, log, health, handleEvent });

  // 归档线：机器人看不到别人私聊主人的消息，只能用主人自己授权的身份去读
  const oauthRoutes = createOAuthRoutes({ db, oauth, api, userToken, config, log });
  const commands = createCommands({ oauthRoutes, log });
  const worker = createWorker({ db, api, files, outbox, router, config, log, commands });
  const archiver = createArchiver({ db, api, userToken, config, log, health, handleEvent });
  const notify = (text) => outbox.queue({
    target: { type: 'open_id', id: config.teacher_open_id },
    msgType: 'text', payload: { text }, purpose: 'alert',
  });
  const watchdog = createWatchdog({
    config, log, health, notify, userToken,
    authLink: () => oauthRoutes.start(),   // 提醒里直接带可点的链接
  });

  const transport = config.live
    ? (config.transport === 'webhook'
      ? createWebhookTransport({ config, log, health, handleEvent })
      : createWsTransport({ config, log, health, handleEvent }))
    : { start: async () => health.set({ wsState: 'disabled' }), stop: async () => {}, status: () => ({ state: 'disabled' }) };

  const http = createHttp({
    config, log, health, db, outbox, files, api, reconcile,
    userToken, oauthRoutes, archiver,
    webhookHandler: transport.handler,
  });

  await http.listen();
  await transport.start();
  log.info('已启动', { port: config.http.port, transport: config.transport, live: config.live, version: config.version });

  // 两个泵：worker 消化来件，outbox 发出去。串行 tick，不并发——飞书有发送频率限制，
  // 且转发卡片必须先于随后的附件到达。
  const pumps = [
    setInterval(() => {
      if (!wakePending && db.counts().messages.new === 0) return;
      wakePending = false;
      worker.tick().catch((e) => log.error('worker tick 失败', { err: e.message }));
    }, WORKER_TICK_MS),
    setInterval(() => {
      outbox.tick().catch((e) => log.error('outbox tick 失败', { err: e.message }));
    }, OUTBOX_TICK_MS),
  ];
  for (const t of pumps) t.unref?.();

  let reconcileTimer = null;
  if (config.live) {
    const everyMs = (config.reconcile?.interval_sec ?? 300) * 1000;
    reconcileTimer = setInterval(() => { reconcile.safeOnce().catch(() => {}); }, everyMs);
    reconcileTimer.unref?.();
    watchdog.start();

    // 先认出自己是谁：群里只转 @ 了机器人的消息，要拿自己的 open_id 去比对 mentions。
    // 拿不到就沿用库里上一次的结果；一次都没存过，handleEvent 会退回「群消息照转」——
    // 宁可多推几张卡片，也不能把真的 @ 静默吞掉。
    if (!config.bot_open_id) {
      try {
        const bot = await api.getBotInfo();
        if (bot.openId) {
          db.setKv('bot_open_id', bot.openId);
          log.info('已确认机器人自己的 open_id', { name: bot.name });
        }
      } catch (e) {
        log.warn('拿不到机器人自己的 open_id，群消息过滤沿用上一次的结果', { err: e.message });
      }
    }

    // 归档线只在授权过之后才跑；没授权时静默不动，healthz 里看得出来
    archiver.start((config.archive?.interval_sec ?? 300) * 1000);
    userToken.startKeepalive();
    const ut = userToken.status();
    if (!ut.authorized) {
      log.warn('用户身份尚未授权，别人私聊你本人的消息暂时收不到。调 POST /api/oauth/start 拿授权链接');
    }
  }

  async function shutdown() {
    for (const t of pumps) clearInterval(t);
    if (reconcileTimer) clearInterval(reconcileTimer);
    watchdog.stop();
    archiver.stop();
    userToken.stopKeepalive();
    await transport.stop();
    await http.close();
    db.raw.close?.();
    log.info('已停止');
  }

  return { config, db, api, files, outbox, worker, handleEvent, reconcile, archiver, userToken, oauthRoutes, watchdog, http, transport, shutdown };
}

// 直接被 node 拉起时才自启；被测试 import 时不自启。
// 必须用 pathToFileURL 比：手拼 `file://` + argv 在 Windows 上会少一个斜杠
// （argv 是 D:\a\b，拼出 file://D:/a/b，而 import.meta.url 是 file:///D:/a/b），
// 判断恒假 → 容器起来什么都不做，而且日志一片安静，极难发现。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await boot();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { app.shutdown().then(() => process.exit(0)).catch(() => process.exit(1)); });
  }
}
