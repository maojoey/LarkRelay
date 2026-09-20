#!/usr/bin/env node
// 运维命令行：管理接口的客户端。在服务器上这样调——
//   docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml exec larkrelay node bin/relay.mjs <子命令>
//
// admin_token 只从 secrets.json 读，**绝不作为命令行参数**（会进 ps 与 shell 历史）。
// 正文一律优先用 --text-file：有些远程执行工具会剥掉引号，带标点或多行的正文直接传会散架。
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const USAGE = `用法：relay <子命令> [选项]

  health                                 查看运行状态（ok=false 时退出码 1）
  send-text --to <谁> (--text <正文> | --text-file <路径>)
  send-file --to <谁> --path <outgoing 下的相对路径> [--as-image]
  inbox [--since 1h|30m|2d] [--limit 20]  列出最近消息
  msg <message_id>                       单条详情（含附件）
  route <relay_message_id>               查转发映射
  reconcile                              手动跑一次对账
  auth                                   拿用户身份授权链接（收别人私聊你本人的消息要用）
  auth --callback-url "<地址>"            同意之后把浏览器地址栏整条粘回来，完成授权
  archive                                手动跑一次用户身份归档

  --to 可写 teacher 或 ou_ 开头的 open_id。

**带标点或多行的正文请用 --text-file**：有些远程执行工具转发命令时会剥掉引号，
先把正文写进文件再引用，才不会散架。
`;

function fail(msg) { process.stderr.write(`${msg}\n`); process.exit(1); }

async function loadEnv() {
  const cfgPath = process.env.RELAY_CONFIG ?? './config.json';
  const secPath = process.env.RELAY_SECRETS ?? './secrets.json';
  let cfg; let sec;
  try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')); } catch (e) { fail(`读不了配置 ${cfgPath}：${e.message}`); }
  try { sec = JSON.parse(await readFile(secPath, 'utf8')); } catch (e) { fail(`读不了密钥 ${secPath}：${e.message}`); }
  if (!sec.admin_token) fail('secrets.admin_token 为空');
  return { base: `http://${cfg.http?.host ?? '127.0.0.1'}:${cfg.http?.port ?? 8310}`, token: sec.admin_token };
}

async function call(env, method, path, body) {
  let res;
  try {
    res = await fetch(env.base + path, {
      method,
      headers: { authorization: `Bearer ${env.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`连不上服务（${env.base}）：${e.message}`);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { fail(`返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (res.status === 401) fail('鉴权失败：admin_token 与服务端不一致');
  if (json.ok === false) fail(`失败：${json.error}`);
  return json.data ?? json;
}

// 1h / 30m / 2d / 纯毫秒
function sinceMs(s) {
  if (!s) return Date.now() - 24 * 3600_000;
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (!m) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    fail(`--since 看不懂：${s}（写成 30m / 2h / 3d）`);
  }
  const unit = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[m[2]];
  return Date.now() - Number(m[1]) * unit;
}

const ts = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');
const ago = (ms) => (ms ? `${Math.round((Date.now() - ms) / 1000)} 秒前` : '从未');
const clip = (s, n) => (!s ? '' : (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\n/g, ' '));

const CMDS = {
  async health(env) {
    const res = await fetch(`${env.base}/healthz`).catch((e) => fail(`连不上服务：${e.message}`));
    const h = await res.json();
    const lines = [
      `状态       ${h.ok ? '正常' : '异常'}（版本 ${h.version}，运行 ${Math.round(h.uptime_ms / 60000)} 分钟）`,
      `传输       ${h.transport}，连接 ${h.ws_state}（最后连上 ${ago(h.ws_last_connect)}）`,
      `最后收事件 ${ago(h.last_event_at)}`,
      `最后对账   ${ago(h.last_poll_at)}，本次补录 ${h.last_poll_missed}，24 小时累计 ${h.missed_24h}`,
      `待处理     新 ${h.queue.new} / 处理中 ${h.queue.processing} / 失败 ${h.queue.failed} / 已完成 ${h.queue.done}`,
      `出站       排队 ${h.outbox.queued} / 失败 ${h.outbox.failed} / 已发 ${h.outbox.sent}`,
      `磁盘可用   ${(h.disk.free_bytes / 1024 ** 3).toFixed(1)} GB`,
    ];
    const u = h.user_identity ?? {};
    if (u.authorized) {
      lines.push(`用户身份   已授权，${u.reauth_due_in_days} 天后需重新授权`
        + `（令牌 ${ago(u.last_refresh_at)}刷新）`);
    } else if (u.reason === 'never_authorized') {
      lines.push('用户身份   ⚠ 尚未授权——别人私聊你本人的消息收不到，跑 relay auth 开始授权');
    } else if (u.reason === 'disabled') {
      lines.push('用户身份   未启用');
    } else {
      lines.push(`用户身份   ⚠ 已失效（${u.dead ?? '未知'}）——跑 relay auth 重新授权`);
    }
    const a = h.archive ?? {};
    lines.push(`归档线     ${ago(a.last_at)}，${a.chats ?? 0} 个会话`
      + (a.failed_chats ? `，${a.failed_chats} 个读不了` : '')
      + (a.fail_streak ? `，连续失败 ${a.fail_streak} 次` : ''));
    if (u.reauth_warning) {
      lines.push(`⚠ 距离官方的 365 天硬顶只剩 ${u.reauth_due_in_days} 天，到期必须人工重新授权一次`);
    }
    if (a.last_error) lines.push(`⚠ 归档最近一次错误：${a.last_error}`);
    if (h.split_suspect) {
      lines.push('⚠ 疑似有第二个消费者在抢同一应用的事件——检查别处是否跑了 lark-cli event consume');
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    if (!h.ok) process.exit(1);
  },

  async 'send-text'(env, { values }) {
    if (!values.to) fail('缺 --to');
    const text = values['text-file'] ? await readFile(values['text-file'], 'utf8') : values.text;
    if (!text) fail('缺 --text 或 --text-file');
    const r = await call(env, 'POST', '/api/send', { to: values.to, text });
    process.stdout.write(`已排队（outbox #${r.id}）\n`);
  },

  async 'send-file'(env, { values }) {
    if (!values.to) fail('缺 --to');
    if (!values.path) fail('缺 --path');
    const r = await call(env, 'POST', '/api/send-file', {
      to: values.to, path: values.path, as_image: Boolean(values['as-image']),
    });
    process.stdout.write(`已排队（outbox #${r.id}）\n`);
  },

  async inbox(env, { values }) {
    const rows = await call(env, 'GET', `/api/messages?since=${sinceMs(values.since)}&limit=${values.limit ?? 20}`);
    if (!rows.length) { process.stdout.write('这段时间没有消息\n'); return; }
    process.stdout.write(`${'时间'.padEnd(20)}${'向'.padEnd(4)}${'类型'.padEnd(12)}${'发件人'.padEnd(22)}正文\n`);
    for (const r of rows) {
      process.stdout.write(
        ts(r.create_time).padEnd(20)
        + (r.direction === 'in' ? '收' : '发').padEnd(4)
        + String(r.msg_type).padEnd(12)
        + String(r.sender_open_id ?? '—').padEnd(22)
        + clip(r.text, 40) + '\n',
      );
    }
  },

  async msg(env, { positionals }) {
    const id = positionals[1];
    if (!id) fail('用法：relay msg <message_id>');
    const m = await call(env, 'GET', `/api/messages/${encodeURIComponent(id)}`);
    process.stdout.write([
      `消息 ${m.message_id}`,
      `  方向 ${m.direction} / 来源 ${m.transport} / 类型 ${m.msg_type} / 状态 ${m.status}`,
      `  时间 ${ts(m.create_time)}    发件人 ${m.sender_open_id ?? '—'}`,
      `  会话 ${m.chat_id}（${m.chat_type}）` + (m.reply_to ? `    回复 ${m.reply_to}` : ''),
      `  正文 ${m.text ?? '（无）'}`,
      ...(m.last_error ? [`  错误 ${m.last_error}（第 ${m.attempts} 次）`] : []),
      ...(m.attachments?.length
        ? ['  附件：', ...m.attachments.map((a) => `    ${a.status.padEnd(9)}${a.file_name ?? a.file_key}  ${a.local_path ?? a.error ?? ''}`)]
        : []),
    ].join('\n') + '\n');
  },

  async route(env, { positionals }) {
    const id = positionals[1];
    if (!id) fail('用法：relay route <relay_message_id>');
    const r = await call(env, 'GET', `/api/routes/${encodeURIComponent(id)}`);
    if (!r?.relay_message_id) { process.stdout.write('没有这条映射——说明它不是中转发出去的消息\n'); return; }
    process.stdout.write([
      `转发消息 ${r.relay_message_id}`,
      `  原始来件 ${r.origin_message_id}`,
      `  回传给   ${r.origin_open_id}（${r.origin_kind}${r.line ? ` · ${r.line}` : ''}）`,
      `  登记于   ${ts(r.created_at)}`,
    ].join('\n') + '\n');
  },

  // 发起用户身份授权。令牌只在服务器上持有和刷新——refresh_token 一次性，
  // 本机再存一份会把服务器那份顶废，所以这里只负责把链接打出来。
  async auth(env, { values }) {
    // 第二步：把浏览器地址栏整条粘回来
    if (values['callback-url']) {
      const r = await call(env, 'POST', '/api/oauth/complete', { callback_url: values['callback-url'] });
      process.stdout.write(`授权成功${r.name ? `（${r.name}）` : ''}。跑 relay health 看看用户身份那行。
`);
      return;
    }
    const r = await call(env, 'POST', '/api/oauth/start', {});
    process.stdout.write([
      '在浏览器里打开下面这个链接，用**你本人**的飞书账号点同意：',
      '',
      `  ${r.url}`,
      '',
      `链接 ${Math.round(r.expires_in_sec / 60)} 分钟内有效。`,
      '',
      '点完同意，浏览器会跳到你登记的重定向地址。那个地址**不需要能打开**——',
      '页面报错也没关系，授权码就在地址栏里。把地址栏**整条**复制下来，再跑：',
      '',
      '  relay auth --callback-url "<粘在这里>"',
      '',
      '注意：换成别人的账号点同意会被拒绝（服务端会核对 open_id）。',
    ].join('\n') + '\n');
  },

  async archive(env) {
    const r = await call(env, 'POST', '/api/archive', {});
    if (r.error) fail(`归档失败：${r.error}`);
    process.stdout.write(`归档完成：${r.chats} 个会话，扫了 ${r.scanned} 条，补录 ${r.missed} 条`
      + (r.failed ? `，${r.failed} 个会话读不了` : '')
      + `（会话发现方式：${r.mode ?? '未知'}）\n`);
  },

  async reconcile(env) {
    const r = await call(env, 'POST', '/api/reconcile', {});
    if (r.error) fail(`对账失败：${r.error}`);
    process.stdout.write(`对账完成：扫了 ${r.scanned} 条，补录 ${r.missed} 条`
      + (r.splitSuspect ? '（⚠ 疑似事件被别处分流）' : '') + '\n');
  },
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    to: { type: 'string' },
    text: { type: 'string' },
    'text-file': { type: 'string' },
    path: { type: 'string' },
    'as-image': { type: 'boolean' },
    'callback-url': { type: 'string' },
    since: { type: 'string' },
    limit: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const cmd = positionals[0];
if (!cmd || values.help || !CMDS[cmd]) {
  process.stdout.write(USAGE);
  process.exit(cmd && !CMDS[cmd] ? 1 : 0);
}
await CMDS[cmd](await loadEnv(), { values, positionals });
