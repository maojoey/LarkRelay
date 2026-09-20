// 配置分两份：config.json（非密，可入库样例）与 secrets.json（只在服务器，0600）。
// RELAY_LIVE 门闩：不为 '1' 时 transport 层一律用 fake，防止本机误起第二个事件消费者造成分流。
import { readFileSync } from 'node:fs';

const REQUIRED_SECRETS = ['app_secret', 'admin_token'];

function readJSON(p, what) {
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`读不了${what}（${p}）：${e.message}`); }
}

export function loadConfig(env = process.env) {
  const cfg = readJSON(env.RELAY_CONFIG ?? './config.json', '配置');
  const sec = readJSON(env.RELAY_SECRETS ?? './secrets.json', '密钥');

  if (!cfg.app_id?.startsWith('cli_')) throw new Error('config.app_id 必须是 cli_ 开头');
  if (!cfg.teacher_open_id?.startsWith('ou_')) throw new Error('config.teacher_open_id 必须是 ou_ 开头');
  if (!['ws', 'webhook'].includes(cfg.transport)) throw new Error('config.transport 只能是 ws 或 webhook');
  for (const k of REQUIRED_SECRETS) if (!sec[k]) throw new Error(`secrets.${k} 不能为空`);
  // webhook 模式才需要这两把；ws 模式下允许为空，但建应用时就填好可省一次密钥旅程。
  if (cfg.transport === 'webhook' && !sec.encrypt_key) throw new Error('webhook 模式必须有 secrets.encrypt_key');

  return {
    ...cfg,
    secrets: sec,
    live: env.RELAY_LIVE === '1',
    version: env.RELAY_VERSION ?? 'dev',
  };
}
