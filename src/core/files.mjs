// 附件落盘。同机还跑着别的服务（比如 MySQL），**磁盘绝不能被写满**，所以三道闸：
// 单文件上限 → 软/硬配额 → 磁盘剩余下限。任何一道触发都只跳过下载，不影响消息本身入库与转发。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, statfs } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const GB = 1024 ** 3;
const CTRL = new RegExp('[\\u0000-\\u001f]', 'g');
const BAD = /[/\\:*?"<>|]/g;

// 保留扩展名，去掉路径分隔符与控制字符；空名兜底。截断防止超出文件系统名长上限。
export function safeName(raw, fallbackExt = '') {
  const s = String(raw ?? '')
    .normalize('NFC')
    .replace(CTRL, '')
    .replace(BAD, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return `file${fallbackExt}`;
  const ext = path.extname(s).slice(0, 16);
  const stem = s.slice(0, s.length - ext.length) || 'file';
  return `${stem.slice(0, 100)}${ext}`;
}

export function relPath(messageId, fileKey, name, now = new Date()) {
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  // 同一条消息可能带多个附件（post 里多张图），用 file_key 前 8 位消歧
  return path.posix.join(y, m, messageId, `${fileKey.slice(0, 8)}-${name}`);
}

export function createFiles({ config, log }) {
  const root = config.paths.files;
  const lim = config.limits;

  async function freeBytes() {
    const st = await statfs(root).catch(() => null);
    return st ? st.bsize * st.bavail : Number.MAX_SAFE_INTEGER;
  }

  // null = 放行；字符串 = 该跳过，内容就是写进 attachments.error 的原因
  async function gate() {
    const free = await freeBytes();
    if (free < lim.min_free_gb * GB) return `磁盘剩余不足 ${lim.min_free_gb}GB，暂不下载`;
    return null;
  }

  // 下载一个附件。**失败不抛**：一个附件坏掉不该让整条消息转发不出去。
  async function store({ api, messageId, fileKey, kind, fileName }) {
    const blocked = await gate();
    if (blocked) return { status: 'deferred', error: blocked };

    const name = safeName(fileName, kind === 'image' ? '.png' : '');
    const rel = relPath(messageId, fileKey, name);
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    try {
      const { size, mime } = await api.download(messageId, fileKey, kind, abs);
      if (size > lim.max_download_mb * 1024 * 1024) {
        await rm(abs, { force: true });
        return { status: 'skipped', error: `超过单文件上限 ${lim.max_download_mb}MB`, size };
      }
      // 流式算摘要，**不要 readFile**：容器 mem_limit 只有 256MB，
      // 一个 100MB 的附件整份读进 Buffer 就可能把进程撑爆。
      const h = createHash('sha256');
      await pipeline(createReadStream(abs), h);
      return { status: 'done', local_path: rel, abs, size, mime, sha256: h.digest('hex'), file_name: name };
    } catch (e) {
      log.warn('附件下载失败', { messageId, fileKey, err: e.message });
      await rm(abs, { force: true });
      return { status: 'failed', error: e.message };
    }
  }

  return { store, freeBytes, absOf: (rel) => path.join(root, rel) };
}
