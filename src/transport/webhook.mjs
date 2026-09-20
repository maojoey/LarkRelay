// Webhook 入口。里程碑 1 不启用，但从第一天就写好并共用同一个 handleEvent：
// 长连接哪天不稳要切回调时，只是翻 config.transport + 挂一段 Caddy，业务代码一行不动。
//
// 回调必须 3 秒内回 200，所以 handleEvent 里不许有网络或文件 IO（它只落库 + 唤醒）。
import * as lark from '@larksuiteoapi/node-sdk';
import { normalize } from '../lark/normalize.mjs';

export function createWebhookTransport({ config, log, health, handleEvent }) {
  const dispatcher = new lark.EventDispatcher({
    encryptKey: config.secrets.encrypt_key,
    verificationToken: config.secrets.verification_token,
  }).register({
    'im.message.receive_v1': async (data) => {
      health.markEvent();
      try {
        handleEvent(normalize(data, 'webhook'));
      } catch (e) {
        log.error('webhook 事件处理失败', { err: e.message });
      }
      return '';
    },
  });

  return {
    // 交给 http.mjs 挂到 config.webhook.path 上；autoChallenge 处理飞书的 url_verification
    handler: lark.adaptDefault(config.webhook.path, dispatcher, { autoChallenge: true }),
    async start() { health.set({ wsState: 'disabled' }); log.info('webhook 模式，未建立长连接'); },
    async stop() {},
    status: () => ({ state: 'disabled' }),
  };
}
