// api.mjs 的内存假实现，方法集与签名必须与它一致。测试与本机开发用，不出网、不需要真凭据。
import { writeFile } from 'node:fs/promises';

export function createFakeApi({ log } = {}) {
  const calls = [];
  const failures = new Map(); // method -> Error，触发一次就消费掉
  const state = { seq: 0, downloadContent: 'fake', inbox: [], chats: [], userInfo: { openId: 'ou_owner', name: 'Owner' } };

  function record(method, args) {
    calls.push({ method, args });
  }

  function maybeFail(method) {
    const err = failures.get(method);
    if (!err) return;
    failures.delete(method);
    log?.warn('fake lark api 按测试要求抛错', { method });
    throw err;
  }

  function nextId() {
    state.seq += 1;
    return `om_fake_${state.seq}`;
  }

  async function getTenantToken() {
    record('getTenantToken', []);
    maybeFail('getTenantToken');
    return 'fake_tenant_token';
  }

  async function sendText(target, text, opts = {}) {
    record('sendText', [target, text, opts]);
    maybeFail('sendText');
    return { message_id: nextId() };
  }

  async function sendCard(target, cardJson, opts = {}) {
    record('sendCard', [target, cardJson, opts]);
    maybeFail('sendCard');
    return { message_id: nextId() };
  }

  async function sendFile(target, localPath, opts = {}) {
    record('sendFile', [target, localPath, opts]);
    maybeFail('sendFile');
    return { message_id: nextId() };
  }

  async function sendImage(target, localPath, opts = {}) {
    record('sendImage', [target, localPath, opts]);
    maybeFail('sendImage');
    return { message_id: nextId() };
  }

  async function download(messageId, fileKey, kind, destPath, opts = {}) {
    record('download', [messageId, fileKey, kind, destPath, opts]);
    maybeFail('download');
    await writeFile(destPath, state.downloadContent);
    return { size: Buffer.byteLength(state.downloadContent), mime: 'application/octet-stream' };
  }

  async function listMessages(chatId, startMs, endMs, opts = {}) {
    record('listMessages', [chatId, startMs, endMs, opts]);
    maybeFail('listMessages');
    return state.inbox;
  }

  async function forward(messageId, target, opts = {}) {
    record('forward', [messageId, target, opts]);
    maybeFail('forward');
    return { message_id: nextId() };
  }

  // 列出当前身份所在的会话：假实现直接返回测试预置的 state.chats。
  async function listMyChats(opts = {}) {
    record('listMyChats', [opts]);
    maybeFail('listMyChats');
    return state.chats;
  }

  // 注意：真实 api.mjs 里这个方法目前恒抛错（飞书没有对应接口）。
  // 假实现按测试需要返回确定性的假 chat_id，签名保持一致即可。
  // 真实端点是 POST /open-apis/im/v1/chat_p2p/batch_query（SDK 类型里没收录，从官方 CLI 挖出来的）。
  // 假实现按同样的形状回：给什么 open_id 就回一个稳定的假 chat_id。
  async function resolveP2pChats(peerOpenIds, opts = {}) {
    record('resolveP2pChats', [peerOpenIds, opts]);
    maybeFail('resolveP2pChats');
    const out = {};
    for (const id of peerOpenIds ?? []) out[id] = `oc_fake_${String(id).slice(-6)}`;
    return out;
  }

  async function resolveP2pChat(peerOpenId, opts = {}) {
    record('resolveP2pChat', [peerOpenId, opts]);
    maybeFail('resolveP2pChat');
    return `oc_fake_${String(peerOpenId).slice(-6)}`;
  }

  async function getUserInfo(opts = {}) {
    record('getUserInfo', [opts]);
    maybeFail('getUserInfo');
    return state.userInfo;
  }

  function reset() {
    calls.length = 0;
    failures.clear();
    state.seq = 0;
    state.downloadContent = 'fake';
    state.inbox = [];
    state.chats = [];
  }

  function failNext(method, error) {
    failures.set(method, error instanceof Error ? error : new Error(String(error)));
  }

  return {
    calls,
    reset,
    failNext,
    getTenantToken,
    sendText,
    sendCard,
    sendFile,
    sendImage,
    download,
    listMessages,
    forward,
    listMyChats,
    resolveP2pChat,
    resolveP2pChats,
    getUserInfo,
    // 测试用检查面：download 的假内容、listMessages/listMyChats 的预置数据，都可直接读写。
    get downloadContent() { return state.downloadContent; },
    set downloadContent(v) { state.downloadContent = v; },
    get userInfo() { return state.userInfo; },
    set userInfo(v) { state.userInfo = v; },
    get inbox() { return state.inbox; },
    set inbox(v) { state.inbox = v; },
    get chats() { return state.chats; },
    set chats(v) { state.chats = v; },
  };
}
