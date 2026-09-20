// 只绑 127.0.0.1。/healthz 免鉴权（只读状态，且要给 Docker healthcheck 用），
// /api/* 一律 Bearer。将来其他内部服务要调时经反向代理暴露，代码不用改。
import { createServer } from 'node:http';
import path from 'node:path';

const GB = 1024 ** 3;

export function createHttp({ config, log, health, db, outbox, files, api, reconcile, webhookHandler, userToken, oauthRoutes, archiver }) {
  const token = config.secrets.admin_token;

  async function healthz() {
    const s = health.get();
    const c = db.counts();
    const free = await files.freeBytes();
    const ut = userToken ? userToken.status() : null;
    const ok = s.wsState !== 'failed'
      && s.pollFailStreak < 3
      && free > (config.limits.min_free_gb ?? 2) * GB
      // 从没授权过不算病（还没到那一步）；授权过又死了才算——那是在静默漏数据
      && !(ut && ut.reason !== 'never_authorized' && !ut.authorized);
    return {
      ok,
      version: config.version,
      transport: config.transport,
      ws_state: s.wsState,
      ws_last_connect: s.wsLastConnect,
      last_event_at: s.lastEventAt,
      last_poll_at: s.lastPollAt,
      last_poll_missed: s.lastPollMissed,
      missed_24h: s.missed24h,
      split_suspect: s.splitSuspect,
      queue: c.messages,
      outbox: c.outbox,
      disk: { free_bytes: free },
      // 用户身份那条线：机器人看不到的消息全靠它，令牌一断就是静默漏数据
      user_identity: userToken ? userToken.status() : { authorized: false, reason: 'disabled' },
      archive: {
        last_at: s.archiveLastAt,
        chats: s.archiveChats,
        failed_chats: s.archiveFailed,
        fail_streak: s.archiveFailStreak,
        last_error: s.archiveLastError,
      },
      uptime_ms: Date.now() - s.startedAt,
    };
  }

  // 出站文件只能来自 outgoing/，不许任意路径——否则管理接口等于任意文件读取
  function resolveOutgoing(p) {
    const root = path.resolve(config.paths.outgoing);
    const abs = path.resolve(root, p);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径必须在 outgoing/ 之内');
    return abs;
  }

  async function readJson(req) {
    const chunks = [];
    for await (const c of req) {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) throw new Error('请求体过大');
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  const routes = {
    'GET /api/messages': async (req, url) => db.listMessages({
      since: Number(url.searchParams.get('since') ?? 0),
      limit: Math.min(Number(url.searchParams.get('limit') ?? 50), 200),
    }),
    'POST /api/send': async (req) => {
      const b = await readJson(req);
      const id = b.to === 'teacher' ? config.teacher_open_id : b.to;
      if (!id) throw new Error('缺少收件人');
      if (!b.text) throw new Error('缺少正文');
      return { id: outbox.queue({ target: { type: 'open_id', id }, msgType: 'text', payload: { text: b.text }, purpose: 'manual' }) };
    },
    'POST /api/send-file': async (req) => {
      const b = await readJson(req);
      const id = b.to === 'teacher' ? config.teacher_open_id : b.to;
      const abs = resolveOutgoing(b.path ?? '');
      const rel = path.relative(path.resolve(config.paths.files), abs);
      return {
        id: outbox.queue({
          target: { type: 'open_id', id },
          msgType: b.as_image ? 'image' : 'file',
          payload: { path: rel, file_name: path.basename(abs) },
          purpose: 'manual',
        }),
      };
    },
    'POST /api/reconcile': async () => reconcile.safeOnce(),
    'POST /api/archive': async () => {
      if (!archiver) throw new Error('归档线未启用');
      return archiver.safeOnce();
    },
    // 只有带 admin token 的主人能发起授权，回调那侧再校验 state 与 open_id
    'POST /api/oauth/start': async () => {
      if (!oauthRoutes) throw new Error('未配置 oauth');
      return oauthRoutes.start();
    },
    // 默认路径：操作者把浏览器地址栏整条粘回来，不需要公网回调
    'POST /api/oauth/complete': async (req) => {
      if (!oauthRoutes) throw new Error('未配置 oauth');
      return oauthRoutes.complete(await readJson(req));
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    try {
      if (webhookHandler && url.pathname === config.webhook.path) return webhookHandler(req, res);

      // 授权回调：飞书重定向过来，带不了 Bearer，所以必须免鉴权。
      // 安全性靠 oauth-routes 里的三道校验（state 一次性、必须先 start、open_id 必须是主人）。
      if (oauthRoutes && url.pathname === (config.oauth?.callback_path ?? '/lark/oauth/callback')) {
        const q = Object.fromEntries(url.searchParams);
        try {
          const r = await oauthRoutes.callback(q);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(`<meta charset="utf-8"><h3>授权成功</h3><p>${escapeHtml(r.name ?? '')}，可以关掉这个页面了。</p>`);
        } catch (e) {
          log.warn('授权回调失败', { err: e.message });
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(`<meta charset="utf-8"><h3>授权失败</h3><p>${escapeHtml(e.message)}</p>`);
        }
      }

      if (url.pathname === '/healthz') {
        const h = await healthz();
        return send(h.ok ? 200 : 503, h);
      }

      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not_found' });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });

      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key]
        ?? (url.pathname.startsWith('/api/messages/') && req.method === 'GET'
          ? async () => {
            const id = decodeURIComponent(url.pathname.slice('/api/messages/'.length));
            const m = db.getMessage(id);
            if (!m) throw new Error('没有这条消息');
            return { ...m, attachments: db.listAttachments(id) };
          }
          : null)
        ?? (url.pathname.startsWith('/api/routes/') && req.method === 'GET'
          ? async () => db.findRoute(decodeURIComponent(url.pathname.slice('/api/routes/'.length))) ?? {}
          : null);

      if (!handler) return send(404, { error: 'not_found' });
      return send(200, { ok: true, data: await handler(req, url) });
    } catch (e) {
      log.warn('http 处理失败', { path: url.pathname, err: e.message });
      return send(400, { ok: false, error: e.message });
    }
  });

  return {
    server,
    healthz,
    listen: () => new Promise((r) => server.listen(config.http.port, config.http.host, r)),
    close: () => new Promise((r) => server.close(r)),
  };
}

// 回调页面会把错误原文显示出来，转义一下免得反射型注入
function escapeHtml(x) {
  return String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
