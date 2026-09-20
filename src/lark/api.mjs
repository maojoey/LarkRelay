// 飞书 OpenAPI 真实封装。SDK 自己管 tenant_access_token 的缓存与刷新，这里不重复实现。
// 硬约束：任何抛出的 Error / 写进 log 的字段都只带飞书返回的 code、msg，绝不带 app_secret。
import { createReadStream, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';

const FILE_TYPE_BY_EXT = {
  '.pdf': 'doc', '.doc': 'doc', '.docx': 'doc',
  '.xls': 'xls', '.xlsx': 'xls',
  '.ppt': 'ppt', '.pptx': 'ppt',
  '.mp4': 'mp4',
  '.opus': 'opus',
};

function fileTypeFor(localPath) {
  return FILE_TYPE_BY_EXT[extname(localPath).toLowerCase()] ?? 'stream';
}

export function createApi({ appId, appSecret, log }) {
  const client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });

  // 飞书业务失败走 HTTP 200 + body.code!=0，axios 不会 reject，SDK 也不检查——这里补上。
  function unwrap(res, label) {
    if (!res || res.code) {
      const code = res?.code ?? 'unknown';
      const msg = res?.msg ?? 'no message';
      log?.error('lark api 业务失败', { label, code, msg });
      throw new Error(`${label} 失败：code=${code} msg=${msg}`);
    }
    return res.data;
  }

  // 网络/协议层异常：只透传 e.message（字符串，不含 secret），不把整个 error 对象序列化出去。
  async function call(fn, label) {
    let res;
    try {
      res = await fn();
    } catch (e) {
      log?.error('lark api 请求异常', { label, message: e.message });
      throw new Error(`${label} 失败：${e.message}`);
    }
    return unwrap(res, label);
  }

  // im.image.create / im.file.create 这两个上传接口，SDK 内部直接 return res.data，业务失败时
  // code/msg 已经被 SDK 丢掉、拿不到，只能报「返回空」。这是 SDK 本身的限制，不是我们没接住。
  async function callUpload(fn, label, keyName) {
    let res;
    try {
      res = await fn();
    } catch (e) {
      log?.error('lark api 请求异常', { label, message: e.message });
      throw new Error(`${label} 失败：${e.message}`);
    }
    if (!res || !res[keyName]) {
      log?.error('lark api 上传返回空', { label });
      throw new Error(`${label} 失败：飞书未返回 ${keyName}（该接口业务失败时 SDK 不透传 code/msg）`);
    }
    return res;
  }

  async function getTenantToken() {
    try {
      const token = await client.tokenManager.getTenantAccessToken();
      if (!token) throw new Error('tenant_access_token 为空');
      return token;
    } catch (e) {
      log?.error('lark getTenantToken 失败', { message: e.message });
      throw new Error(`getTenantToken 失败：${e.message}`);
    }
  }

  async function sendByContent(target, content, msgType, { replyTo, uuid } = {}, label) {
    if (replyTo) {
      const data = await call(() => client.im.message.reply({
        path: { message_id: replyTo },
        data: { content, msg_type: msgType, ...(uuid ? { uuid } : {}) },
      }), label);
      return { message_id: data.message_id };
    }
    const data = await call(() => client.im.message.create({
      params: { receive_id_type: target.type },
      data: { receive_id: target.id, msg_type: msgType, content, ...(uuid ? { uuid } : {}) },
    }), label);
    return { message_id: data.message_id };
  }

  async function sendText(target, text, opts = {}) {
    return sendByContent(target, JSON.stringify({ text }), 'text', opts, 'sendText');
  }

  async function sendCard(target, cardJson, opts = {}) {
    const content = typeof cardJson === 'string' ? cardJson : JSON.stringify(cardJson);
    return sendByContent(target, content, 'interactive', opts, 'sendCard');
  }

  async function sendFile(target, localPath, { fileName, uuid } = {}) {
    const file_type = fileTypeFor(localPath);
    const file_name = fileName ?? basename(localPath);
    const uploaded = await callUpload(() => client.im.file.create({
      data: { file_type, file_name, file: createReadStream(localPath) },
    }), 'sendFile', 'file_key');
    return sendByContent(target, JSON.stringify({ file_key: uploaded.file_key }), 'file', { uuid }, 'sendFile');
  }

  async function sendImage(target, localPath, { uuid } = {}) {
    const uploaded = await callUpload(() => client.im.image.create({
      data: { image_type: 'message', image: createReadStream(localPath) },
    }), 'sendImage', 'image_key');
    return sendByContent(target, JSON.stringify({ image_key: uploaded.image_key }), 'image', { uuid }, 'sendImage');
  }

  async function download(messageId, fileKey, kind, destPath) {
    const type = kind === 'image' ? 'image' : 'file';
    let res;
    try {
      res = await client.im.messageResource.get({
        params: { type },
        path: { message_id: messageId, file_key: fileKey },
      });
    } catch (e) {
      log?.error('lark api 请求异常', { label: 'download', message: e.message });
      throw new Error(`download 失败：${e.message}`);
    }
    await res.writeFile(destPath);
    const { size } = statSync(destPath);
    const headers = res.headers ?? {};
    const mime = typeof headers.get === 'function'
      ? (headers.get('content-type') ?? 'application/octet-stream')
      : (headers['content-type'] ?? 'application/octet-stream');
    return { size, mime };
  }

  async function listMessages(chatId, startMs, endMs) {
    const items = [];
    let pageToken;
    for (let page = 0; page < 20; page += 1) {
      const data = await call(() => client.im.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: String(Math.floor(startMs / 1000)),
          end_time: String(Math.floor(endMs / 1000)),
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }), 'listMessages');
      items.push(...(data?.items ?? []));
      if (!data?.has_more || !data?.page_token) break;
      pageToken = data.page_token;
    }
    return items;
  }

  async function forward(messageId, target) {
    const data = await call(() => client.im.message.forward({
      path: { message_id: messageId },
      params: { receive_id_type: target.type },
      data: { receive_id: target.id },
    }), 'forward');
    return { message_id: data.message_id };
  }

  return { getTenantToken, sendText, sendCard, sendFile, sendImage, download, listMessages, forward };
}
