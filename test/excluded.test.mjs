// 排除名单：整群不入库。两条入口都要管住——实时事件走 handleEvent，
// 应用/机器人发的走 pull 的 insertOutbound（那条路绕开 handleEvent）。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.mjs';
import { createFakeApi } from '../src/lark/fake.mjs';
import { createHandleEvent } from '../src/core/handleEvent.mjs';
import { createPull } from '../src/core/pull.mjs';
import { createIsExcluded } from '../src/core/excluded.mjs';

const SKIP = 'oc_bots_only';
const KEEP = 'oc_seminar';
const silent = { info() {}, warn() {}, error() {} };

const config = {
  teacher_open_id: 'ou_teacher',
  archive: { exclude_chats: [SKIP] },
};

function msg(over = {}) {
  return {
    message_id: 'om_1', chat_id: KEEP, chat_type: 'group',
    sender_open_id: 'ou_teacher', sender_type: 'user', msg_type: 'text',
    text: 'hi', content: { text: 'hi' }, create_time: Date.now(),
    transport: 'ws', attachments: [], mentions: [],
    ...over,
  };
}

describe('排除名单', () => {
  let db; let handleEvent; let isExcluded;
  beforeEach(() => {
    db = openDb(':memory:');
    isExcluded = createIsExcluded(config);
    handleEvent = createHandleEvent({ db, config, log: silent, wake: () => {}, isExcluded });
  });

  test('没配 exclude_chats 时谁都不排除', () => {
    const none = createIsExcluded({});
    assert.equal(none(SKIP), false);
  });

  test('实时事件：排除的群一行都不写', () => {
    const r = handleEvent(msg({ message_id: 'om_x', chat_id: SKIP }));
    assert.equal(r.excluded, true);
    assert.equal(db.getMessage('om_x'), undefined);
  });

  test('没排除的群照常入库', () => {
    handleEvent(msg({ message_id: 'om_y' }));
    assert.ok(db.getMessage('om_y'));
  });

  test('pull：排除的群整个跳过，且不推游标', async () => {
    const api = createFakeApi({ log: silent });
    const pull = createPull({ db, api, log: silent, handleEvent, isExcluded });
    api.inbox = [{
      message_id: 'om_card', chat_id: SKIP, msg_type: 'interactive',
      body: { content: '{}' }, sender: { id: 'cli_app', sender_type: 'app', id_type: 'app_id' },
      create_time: String(Date.now()),
    }];
    const r = await pull.pullChat({ chatId: SKIP, chatType: 'group' });
    assert.deepEqual(r, { scanned: 0, missed: 0, skipped: true });
    assert.equal(db.getMessage('om_card'), undefined);
    // 游标没动：将来撤销排除时这段历史还补得回来
    assert.equal(db.getKv(`poll_cursor:${SKIP}`), undefined);
  });
});
