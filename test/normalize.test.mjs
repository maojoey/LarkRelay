// normalize() 的输入全部手写 JSON，不出网。覆盖三种来源形状 + 字段分歧 + 异常输入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/lark/normalize.mjs';

function wsEvent({ messageType, content, extra = {}, senderExtra = {} }) {
  return {
    sender: { sender_id: { open_id: 'ou_sender1' }, sender_type: 'user', ...senderExtra },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: messageType,
      create_time: '1700000000123',
      content,
      ...extra,
    },
  };
}

test('text：抽取文本并用 mentions 还原 @占位', () => {
  const raw = wsEvent({
    messageType: 'text',
    content: JSON.stringify({ text: '你好 @_user_1 在吗' }),
    extra: { mentions: [{ key: '@_user_1', id: { open_id: 'ou_mentioned' }, name: '小明' }] },
  });
  const out = normalize(raw, 'ws');

  assert.equal(out.message_id, 'om_1');
  assert.equal(out.chat_id, 'oc_1');
  assert.equal(out.chat_type, 'group');
  assert.equal(out.sender_open_id, 'ou_sender1');
  assert.equal(out.sender_type, 'user');
  assert.equal(out.msg_type, 'text');
  assert.equal(out.text, '你好 @小明 在吗');
  assert.deepEqual(out.content, { text: '你好 @_user_1 在吗' });
  assert.equal(out.reply_to, null);
  assert.equal(out.root_id, null);
  assert.equal(out.thread_id, null);
  assert.equal(out.create_time, 1700000000123); // 字符串毫秒转整数
  assert.equal(out.transport, 'ws');
  assert.deepEqual(out.mentions, [{ key: '@_user_1', name: '小明', open_id: 'ou_mentioned' }]);
  assert.deepEqual(out.attachments, []);
  assert.equal(out.raw, raw);
  assert.ok(!('ignore' in out));
});

test('post：拍平多行，text/a/at/img 各标签都处理', () => {
  const content = JSON.stringify({
    post: {
      zh_cn: {
        title: '标题',
        content: [
          [
            { tag: 'text', text: '看看这个 ' },
            { tag: 'a', text: '链接', href: 'https://x.com' },
            { tag: 'text', text: ' 和' },
          ],
          [
            { tag: 'at', user_id: 'ou_x', user_name: '小明' },
            { tag: 'img', image_key: 'img_key_1' },
          ],
        ],
      },
    },
  });
  const raw = wsEvent({ messageType: 'post', content });
  const out = normalize(raw, 'webhook');

  assert.equal(out.text, '看看这个 「链接」(https://x.com) 和\n@小明');
  assert.deepEqual(out.attachments, [{ file_key: 'img_key_1', kind: 'image', file_name: null }]);
});

test('image：attachments 取 image_key，text 为 null', () => {
  const raw = wsEvent({ messageType: 'image', content: JSON.stringify({ image_key: 'img_abc' }) });
  const out = normalize(raw, 'ws');

  assert.equal(out.text, null);
  assert.deepEqual(out.attachments, [{ file_key: 'img_abc', kind: 'image', file_name: null }]);
});

test('file：attachments 取 file_key + file_name', () => {
  const raw = wsEvent({
    messageType: 'file',
    content: JSON.stringify({ file_key: 'file_abc', file_name: 'doc.pdf' }),
  });
  const out = normalize(raw, 'ws');

  assert.deepEqual(out.attachments, [{ file_key: 'file_abc', kind: 'file', file_name: 'doc.pdf' }]);
});

test('media（视频）：封面 image_key 忽略，只收 file_key', () => {
  const raw = wsEvent({
    messageType: 'media',
    content: JSON.stringify({ file_key: 'vid_abc', file_name: 'movie.mp4', image_key: 'cover_key', duration: 5000 }),
  });
  const out = normalize(raw, 'ws');

  assert.deepEqual(out.attachments, [{ file_key: 'vid_abc', kind: 'file', file_name: 'movie.mp4' }]);
});

test('im.message.list 项：扁平结构，sender.id 就是 open_id，chat_type 用第三参数补', () => {
  const raw = {
    message_id: 'om_2',
    chat_id: 'oc_2',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: 'hi' }) },
    sender: { id: 'ou_sender2', sender_type: 'user', id_type: 'open_id' },
    create_time: '1700000001000',
    update_time: '1700000001500',
    deleted: false,
  };

  const withDefault = normalize(raw, 'poll');
  assert.equal(withDefault.chat_type, 'p2p'); // 缺省

  const withChatType = normalize(raw, 'poll', { chatType: 'group' });
  assert.equal(withChatType.chat_type, 'group');
  assert.equal(withChatType.sender_open_id, 'ou_sender2');
  assert.equal(withChatType.text, 'hi');
  assert.equal(withChatType.create_time, 1700000001000);
  assert.equal(withChatType.transport, 'poll');
});

test('回复：parent_id 是原始事件的字段名', () => {
  const raw = wsEvent({
    messageType: 'text',
    content: JSON.stringify({ text: '回复内容' }),
    extra: { parent_id: 'om_parent' },
  });
  const out = normalize(raw, 'ws');
  assert.equal(out.reply_to, 'om_parent');
});

test('回复：reply_to 是 lark-cli 规范化后的别名，parent_id 缺失时也要认', () => {
  const raw = wsEvent({
    messageType: 'text',
    content: JSON.stringify({ text: '回复内容' }),
    extra: { reply_to: 'om_parent2' },
  });
  const out = normalize(raw, 'ws');
  assert.equal(out.reply_to, 'om_parent2');
});

test('content 不是合法 JSON：不抛，text=null，content 原样保留字符串', () => {
  const raw = wsEvent({ messageType: 'text', content: 'not-json{{' });
  const out = normalize(raw, 'ws');

  assert.equal(out.text, null);
  assert.equal(out.content, 'not-json{{');
  assert.deepEqual(out.attachments, []);
});

test('sticker：正常 normalize，但额外标 ignore: true', () => {
  const raw = wsEvent({ messageType: 'sticker', content: JSON.stringify({ file_key: 'stk_1' }) });
  const out = normalize(raw, 'ws');

  assert.equal(out.ignore, true);
  assert.equal(out.msg_type, 'sticker');
});

test('已经 normalize 过的对象：幂等，原样返回同一个引用', () => {
  const raw = wsEvent({ messageType: 'text', content: JSON.stringify({ text: 'hi' }) });
  const once = normalize(raw, 'ws');
  const twice = normalize(once, 'ws');
  assert.equal(twice, once);
});

// SDK 抛的是 AxiosError，e.message 只有「Request failed with status code 400」。
// 真正的原因在 e.response.data 里。只说 400 等于没说——被这个坑了三次才补。
test('错误信息要带出飞书真正说了什么', async () => {
  const { describeError } = await import('../src/lark/api.mjs');
  const e = Object.assign(new Error('Request failed with status code 400'), {
    response: { data: { code: 232001, msg: 'invalid request parameter', error: { ext: 'p2p only supported under UAT' } } },
    config: { data: JSON.stringify({ app_secret: 'TOPSECRET' }) },
  });
  const out = describeError(e);
  assert.match(out, /code=232001/);
  assert.match(out, /ext=p2p only supported under UAT/, 'ext 里往往写着确切症结，不能丢');
  assert.ok(!out.includes('TOPSECRET'), '整个 error 对象带着请求体，里面有 app_secret，绝不能带出来');
});

test('没有响应体时退回原始 message，不要变成 undefined', async () => {
  const { describeError } = await import('../src/lark/api.mjs');
  assert.equal(describeError(new Error('ECONNRESET')), 'ECONNRESET');
});

test('视频会议事件有可读摘要，不再是空卡片', () => {
  const out = normalize(wsEvent({
    messageType: 'video_chat',
    content: JSON.stringify({ topic: '周会的视频会议', meet_number: '100000000' }),
  }), 'ws');
  assert.equal(out.text, '发起了视频会议：周会的视频会议');
  assert.equal(out.ignore, undefined);
});

test('视频会议没有 topic 时也给一句话，不留空', () => {
  const out = normalize(wsEvent({ messageType: 'video_chat', content: JSON.stringify({}) }), 'ws');
  assert.equal(out.text, '发起了视频会议');
});
