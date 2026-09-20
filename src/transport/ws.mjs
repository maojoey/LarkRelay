// 长连接入口。**同一个飞书应用的多个活跃长连接会分流事件**，所以全世界只许有这一个消费者在跑：
// 本机的 lark-cli 绝不能对同一应用 event consume，否则消息会被随机抢走一半。
// 代码层的保险是 config.live（RELAY_LIVE=1），不为真时 index.mjs 根本不调这里。
import * as lark from '@larksuiteoapi/node-sdk';
import { normalize } from '../lark/normalize.mjs';

export function createWsTransport({ config, log, health, handleEvent }) {
  // 刻意不传 encryptKey / verificationToken：长连接下 WSClient 调的是
  // `dispatcher.invoke(data, { needCheck: false })`（SDK lib/index.js 里那一处），
  // 校验与解密整段跳过。这两把只有 webhook 模式才用得上，见 transport/webhook.mjs。
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      health.markEvent();
      try {
        handleEvent(normalize(data, 'ws'));
      } catch (e) {
        // 抛回给 SDK 只会被吞掉，还可能让它以为要重投；这里自己记，消息靠对账兜底
        log.error('ws 事件处理失败', { err: e.message });
      }
      return '';
    },
  });

  const client = new lark.WSClient({
    appId: config.app_id,
    appSecret: config.secrets.app_secret,
    domain: lark.Domain.Feishu,
    autoReconnect: true,
    source: 'larkrelay',
    // 服务端静默时，只靠 socket error 发现断线可能要等很久；给个 liveness 窗口主动判死。
    wsConfig: { pingTimeout: 60 },
    handshakeTimeoutMs: 20_000,
    onReady: () => { health.set({ wsState: 'connected', wsLastConnect: Date.now() }); log.info('ws 已连接'); },
    onReconnecting: () => { health.set({ wsState: 'reconnecting' }); log.warn('ws 断开，重连中'); },
    onReconnected: () => { health.set({ wsState: 'connected', wsLastConnect: Date.now() }); log.info('ws 已重连'); },
    onError: (err) => { health.set({ wsState: 'failed' }); log.error('ws 连接失败', { err: err?.message }); },
  });

  return {
    async start() {
      health.set({ wsState: 'connecting' });
      client.start({ eventDispatcher: dispatcher });
    },
    async stop() {
      try { client.close({ force: true }); } catch { /* 关闭失败不阻塞退出 */ }
      health.set({ wsState: 'idle' });
    },
    status: () => client.getConnectionStatus?.() ?? { state: 'unknown' },
  };
}
