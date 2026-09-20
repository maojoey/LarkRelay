// 真启动测试。单元测试拦不住漏 import、依赖注错、路由没挂这类接线错误——
// 只有把整个进程装配起来跑一遍才拦得住。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { boot } from '../src/index.mjs';

const TOKEN = 'test_admin_token';
let root; let app; let base;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'larkrelay-boot-'));
  await mkdir(path.join(root, 'db'), { recursive: true });
  const port = 18300 + Math.floor(Math.random() * 500);
  const cfg = {
    app_id: 'cli_test',
    transport: 'ws',
    teacher_open_id: 'ou_teacher',
    teacher_name: '老师',
    http: { host: '127.0.0.1', port },
    paths: {
      db: path.join(root, 'db', 'relay.sqlite'),
      files: path.join(root, 'files'),
      outgoing: path.join(root, 'outgoing'),
    },
    limits: { max_download_mb: 100, files_soft_quota_gb: 10, files_hard_quota_gb: 15, min_free_gb: 0 },
    reconcile: { interval_sec: 300, overlap_sec: 600 },
    watchdog: { disconnected_exit_sec: 180, alert_cooldown_sec: 3600 },
    webhook: { path: '/lark/events' },
  };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(cfg));
  await writeFile(path.join(root, 'secrets.json'), JSON.stringify({ app_secret: 'x', admin_token: TOKEN }));

  // 不设 RELAY_LIVE：门闩生效，用 fake api，不建立任何长连接
  app = await boot({
    env: {
      RELAY_CONFIG: path.join(root, 'config.json'),
      RELAY_SECRETS: path.join(root, 'secrets.json'),
      RELAY_VERSION: 'test',
    },
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app?.shutdown();
  await rm(root, { recursive: true, force: true });
});

describe('真启动', () => {
  test('/healthz 免鉴权且字段齐全', async () => {
    const r = await fetch(`${base}/healthz`);
    assert.equal(r.status, 200);
    const h = await r.json();
    assert.equal(h.ok, true);
    assert.equal(h.version, 'test');
    for (const k of ['ws_state', 'last_event_at', 'last_poll_at', 'missed_24h', 'queue', 'outbox', 'disk', 'uptime_ms']) {
      assert.ok(k in h, `healthz 缺字段 ${k}`);
    }
    assert.equal(h.ws_state, 'disabled', 'RELAY_LIVE 未置 1 时不许建立长连接');
  });

  test('/api/* 无令牌 401，有令牌 200', async () => {
    assert.equal((await fetch(`${base}/api/messages`)).status, 401);
    const r = await fetch(`${base}/api/messages`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).data, []);
  });

  test('事件进来能一路走到出站（端到端接线）', async () => {
    app.handleEvent({
      message_id: 'om_boot_1',
      chat_id: 'oc_p2p',
      chat_type: 'p2p',
      sender_open_id: 'ou_teacher',
      sender_type: 'user',
      msg_type: 'text',
      text: '接线测试',
      content: { text: '接线测试' },
      create_time: Date.now(),
      transport: 'ws',
      attachments: [],
    });
    await app.worker.tick();
    await app.outbox.tick();

    const cards = app.api.calls.filter((c) => c.method === 'sendCard');
    assert.equal(cards.length, 1);
    assert.equal(app.db.getMessage('om_boot_1').status, 'done');
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.equal(h.outbox.sent, 1);
  });

  test('管理接口能排队一条文字', async () => {
    const r = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'teacher', text: '来自管理接口' }),
    });
    assert.equal(r.status, 200);
    await app.outbox.tick();
    assert.ok(app.api.calls.some((c) => c.method === 'sendText' && c.args[1] === '来自管理接口'));
  });

  test('发文件的路径必须在 outgoing 之内（防路径穿越）', async () => {
    const r = await fetch(`${base}/api/send-file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'teacher', path: '../../../etc/passwd' }),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /outgoing/);
  });

  test('未知路径 404', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

// 上面那个 describe 是 import boot() 跑的，**拦不住自启守卫写错**：
// 2026-09-20 就踩过——手拼 `file://`+argv 在 Windows 上少一个斜杠，判断恒假，
// 容器起来什么都不做、日志还一片安静。只有真 spawn 一个进程才看得出来。
describe('spawn 真进程', () => {
  test('node src/index.mjs 能自启并响应 /healthz，SIGTERM 能干净退出', async () => {
    const { spawn } = await import('node:child_process');
    const dir = await mkdtemp(path.join(tmpdir(), 'larkrelay-spawn-'));
    const port = 18800 + Math.floor(Math.random() * 500);
    try {
      await mkdir(path.join(dir, 'db'), { recursive: true });
      await writeFile(path.join(dir, 'config.json'), JSON.stringify({
        app_id: 'cli_test', transport: 'ws', teacher_open_id: 'ou_teacher', teacher_name: '老师',
        http: { host: '127.0.0.1', port },
        paths: {
          db: path.join(dir, 'db', 'relay.sqlite'),
          files: path.join(dir, 'files'),
          outgoing: path.join(dir, 'outgoing'),
        },
        limits: { max_download_mb: 100, files_soft_quota_gb: 10, files_hard_quota_gb: 15, min_free_gb: 0 },
        reconcile: { interval_sec: 300, overlap_sec: 600 },
        watchdog: { disconnected_exit_sec: 180, alert_cooldown_sec: 3600 },
        webhook: { path: '/lark/events' },
      }));
      await writeFile(path.join(dir, 'secrets.json'), JSON.stringify({ app_secret: 'x', admin_token: 'spawn_tok' }));

      const child = spawn(process.execPath, ['src/index.mjs'], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
          ...process.env,
          RELAY_CONFIG: path.join(dir, 'config.json'),
          RELAY_SECRETS: path.join(dir, 'secrets.json'),
          RELAY_VERSION: 'spawn',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { out += b; });

      try {
        let health = null;
        for (let i = 0; i < 60 && !health; i += 1) {
          await new Promise((r) => setTimeout(r, 250));
          health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json()).catch(() => null);
        }
        assert.ok(health, `进程没起来或没监听。输出：\n${out.slice(0, 800)}`);
        assert.equal(health.version, 'spawn');
        assert.equal(health.ok, true);
      } finally {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
        if (code === 'timeout') { child.kill('SIGKILL'); assert.fail('SIGTERM 后 8 秒没退出'); }
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
