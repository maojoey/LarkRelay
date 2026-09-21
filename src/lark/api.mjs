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

  // asUser 有值 → 以该用户身份调用（IRequestOptions，作 SDK 方法的第二个参数）；
  // 没有 → 维持现状，走应用身份，SDK 自己管 tenant_access_token。
  function userOpts(asUser) {
    return asUser ? lark.withUserAccessToken(asUser) : undefined;
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

  async function sendByContent(target, content, msgType, { replyTo, uuid, asUser } = {}, label) {
    const options = userOpts(asUser);
    if (replyTo) {
      const data = await call(() => client.im.message.reply({
        path: { message_id: replyTo },
        data: { content, msg_type: msgType, ...(uuid ? { uuid } : {}) },
      }, options), label);
      return { message_id: data.message_id };
    }
    const data = await call(() => client.im.message.create({
      params: { receive_id_type: target.type },
      data: { receive_id: target.id, msg_type: msgType, content, ...(uuid ? { uuid } : {}) },
    }, options), label);
    return { message_id: data.message_id };
  }

  async function sendText(target, text, opts = {}) {
    return sendByContent(target, JSON.stringify({ text }), 'text', opts, 'sendText');
  }

  async function sendCard(target, cardJson, opts = {}) {
    const content = typeof cardJson === 'string' ? cardJson : JSON.stringify(cardJson);
    return sendByContent(target, content, 'interactive', opts, 'sendCard');
  }

  async function sendFile(target, localPath, { fileName, uuid, asUser } = {}) {
    const options = userOpts(asUser);
    const file_type = fileTypeFor(localPath);
    const file_name = fileName ?? basename(localPath);
    const uploaded = await callUpload(() => client.im.file.create({
      data: { file_type, file_name, file: createReadStream(localPath) },
    }, options), 'sendFile', 'file_key');
    return sendByContent(target, JSON.stringify({ file_key: uploaded.file_key }), 'file', { uuid, asUser }, 'sendFile');
  }

  async function sendImage(target, localPath, { uuid, asUser } = {}) {
    const options = userOpts(asUser);
    const uploaded = await callUpload(() => client.im.image.create({
      data: { image_type: 'message', image: createReadStream(localPath) },
    }, options), 'sendImage', 'image_key');
    return sendByContent(target, JSON.stringify({ image_key: uploaded.image_key }), 'image', { uuid, asUser }, 'sendImage');
  }

  async function download(messageId, fileKey, kind, destPath, { asUser } = {}) {
    const type = kind === 'image' ? 'image' : 'file';
    let res;
    try {
      res = await client.im.messageResource.get({
        params: { type },
        path: { message_id: messageId, file_key: fileKey },
      }, userOpts(asUser));
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

  async function listMessages(chatId, startMs, endMs, { asUser } = {}) {
    const options = userOpts(asUser);
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
      }, options), 'listMessages');
      items.push(...(data?.items ?? []));
      if (!data?.has_more || !data?.page_token) break;
      pageToken = data.page_token;
    }
    return items;
  }

  async function forward(messageId, target, { asUser } = {}) {
    const data = await call(() => client.im.message.forward({
      path: { message_id: messageId },
      params: { receive_id_type: target.type },
      data: { receive_id: target.id },
    }, userOpts(asUser)), 'forward');
    return { message_id: data.message_id };
  }

  // 列出当前身份（应用或 asUser 指定的用户）所在的会话。
  //
  // **types 里带 p2p 只有用户身份能用。** 机器人身份传了会被整个请求拒掉：
  // code 232001「p2p only supported under UAT」——不是少返回单聊，是一条都不返回。
  // 所以机器人身份调用时只传 group；机器人的单聊靠实时事件去标记。
  // （官方文档只说「结果不含单聊」，没说传了会报错，这一条是实测出来的。）
  async function listMyChats({ types = 'p2p,group', asUser } = {}) {
    const options = userOpts(asUser);
    const items = [];
    let pageToken;
    for (let page = 0; page < 20; page += 1) {
      const data = await call(() => client.im.chat.list({
        params: {
          user_id_type: 'open_id',
          sort_type: 'ByCreateTimeAsc',
          page_size: 20,
          types,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }, options), 'listMyChats');
      items.push(...(data?.items ?? []));
      if (!data?.has_more || !data?.page_token) break;
      pageToken = data.page_token;
    }
    return items;
  }

  // 已知对方 open_id，批量换取与他们的单聊 chat_id。
  //
  // **SDK 的类型定义里没有这个接口**（`im.chat` 下只有 get/list/search/create/update/delete/link，
  // create 只能建群），所以得用 client.request 直接打。端点是从官方 CLI 的 dry-run 里挖出来的，
  // 它解析 `--user-id` 走的就是这条。纯查询、无副作用。
  //
  // 为什么不用「发一条消息，从返回里取 chat_id」那个办法：那会真的给对方发消息，
  // 拿 chat_id 的代价是骚扰人，不能接受。
  async function resolveP2pChats(peerOpenIds, { asUser } = {}) {
    if (!peerOpenIds?.length) return {};
    const out = {};
    // 批量接口，分片避免请求过大
    for (let i = 0; i < peerOpenIds.length; i += 100) {
      const slice = peerOpenIds.slice(i, i + 100);
      const data = await call(() => client.request({
        method: 'POST',
        url: '/open-apis/im/v1/chat_p2p/batch_query',
        params: { user_id_type: 'open_id' },
        data: { user_id_list: slice },
      }, userOpts(asUser)), 'resolveP2pChats');
      for (const it of data?.p2p_chats ?? data?.items ?? []) {
        const uid = it.user_id ?? it.open_id;
        if (uid && it.chat_id) out[uid] = it.chat_id;
      }
    }
    return out;
  }

  // 拿「当前这个用户令牌属于谁」。授权回调里用它做身份校验：
  // 回调地址必须公开可达，不校验的话任何人都能用自己的账号走完流程、把主人的令牌顶掉。
  async function getUserInfo({ asUser }) {
    const data = await call(() => client.request({
      method: 'GET',
      url: '/open-apis/authen/v1/user_info',
    }, userOpts(asUser)), 'getUserInfo');
    return { openId: data?.open_id ?? null, name: data?.name ?? null };
  }

  const resolveP2pChat = async (peerOpenId, opts) =>
    (await resolveP2pChats([peerOpenId], opts))[peerOpenId] ?? null;

  return {
    getTenantToken, sendText, sendCard, sendFile, sendImage, download, listMessages, forward,
    listMyChats, resolveP2pChat, resolveP2pChats, getUserInfo,
  };
}
