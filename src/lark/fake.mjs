// api.mjs 的内存假实现，方法集与签名必须与它一致。测试与本机开发用，不出网、不需要真凭据。
import { writeFile } from 'node:fs/promises';

export function createFakeApi({ log } = {}) {
  const calls = [];
  const failures = new Map(); // method -> Error，触发一次就消费掉
  const state = { seq: 0, downloadContent: 'fake', inbox: [] };

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

  async function download(messageId, fileKey, kind, destPath) {
    record('download', [messageId, fileKey, kind, destPath]);
    maybeFail('download');
    await writeFile(destPath, state.downloadContent);
    return { size: Buffer.byteLength(state.downloadContent), mime: 'application/octet-stream' };
  }

  async function listMessages(chatId, startMs, endMs) {
    record('listMessages', [chatId, startMs, endMs]);
    maybeFail('listMessages');
    return state.inbox;
  }

  async function forward(messageId, target) {
    record('forward', [messageId, target]);
    maybeFail('forward');
    return { message_id: nextId() };
  }

  function reset() {
    calls.length = 0;
    failures.clear();
    state.seq = 0;
    state.downloadContent = 'fake';
    state.inbox = [];
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
    // 测试用检查面：download 的假内容、listMessages 的预置收件箱，都可直接读写。
    get downloadContent() { return state.downloadContent; },
    set downloadContent(v) { state.downloadContent = v; },
    get inbox() { return state.inbox; },
    set inbox(v) { state.inbox = v; },
  };
}
