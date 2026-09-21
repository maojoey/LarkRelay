// api.mjs 的响应解包。**不出网**：注入一个假 client，喂进飞书真实的响应形状。
//
// 为什么专门给 bot/v3/info 写测试：它是少数把业务数据放在响应顶层、没有 data 包层的老接口，
// 而 unwrap() 统一取 res.data。2026-09-21 踩过——解出来是 undefined，一路静默成 openId=null，
// 部署完没抛错也没日志，功能就是不生效。fake api 是按正确形状写的，所以拦不住这类错。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from '../src/lark/api.mjs';

const silent = { info() {}, warn() {}, error() {} };
const apiWith = (response) => createApi({
  appId: 'cli_x', appSecret: 'x', log: silent, client: { request: async () => response },
});

test('bot/v3/info 把 bot 放在顶层也能解出 open_id', async () => {
  const api = apiWith({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot1', app_name: '助理机器人' } });
  assert.deepEqual(await api.getBotInfo(), { openId: 'ou_bot1', name: '助理机器人' });
});

test('将来飞书要是补上 data 包层，也照样解得出', async () => {
  const api = apiWith({ code: 0, msg: 'ok', data: { bot: { open_id: 'ou_bot2', app_name: 'X' } } });
  assert.equal((await api.getBotInfo()).openId, 'ou_bot2');
});

test('没返回 open_id 要抛，不能静默给 null', async () => {
  const api = apiWith({ code: 0, msg: 'ok', bot: {} });
  await assert.rejects(() => apiWith({ code: 0, msg: 'ok' }).getBotInfo(), /open_id/);
  await assert.rejects(() => api.getBotInfo(), /open_id/);
});

test('业务失败仍然按 code/msg 报错', async () => {
  const api = apiWith({ code: 99991679, msg: 'Unauthorized' });
  await assert.rejects(() => api.getBotInfo(), /code=99991679/);
});
