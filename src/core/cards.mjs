// 转发卡片是回复路由的锚：老师「回复」它，事件里 reply_to 才有值，才查得到原主。
// 抬头必须写清来自谁——老师私聊里会堆着不同人的转发，抬头是防止回错人的唯一视觉信号。
const LINE_LABEL = { thesis: '选题', mentor: '导师', grad: '研究生', self: '自环' };
const LINE_COLOR = { thesis: 'blue', mentor: 'turquoise', grad: 'purple', self: 'grey' };

export function forwardCard({ name, line, text, attachments = [] }) {
  const elements = [];
  if (text) elements.push({ tag: 'div', text: { tag: 'plain_text', content: text } });
  for (const a of attachments) {
    const label = a.file_name ?? '未命名';
    const note = a.status === 'done'
      ? `附件：${label}（${fmtSize(a.size)}）已存档`
      : `附件：${label} 未存档（${a.error ?? a.status}）`;
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: note } });
  }
  if (elements.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: '（空消息）' } });
  }
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '直接「回复」这张卡片，内容会回传给对方' }],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `来自 ${name} · ${LINE_LABEL[line] ?? '未分线'}` },
      template: LINE_COLOR[line] ?? 'grey',
    },
    elements,
  };
}

// 学生看到的是机器人在说话，所以要前缀，不伪装成老师本人。
export function relayPrefix(originKind, ownerName) {
  return originKind === 'self' ? '[回传自测] ' : `${ownerName}回复：`;
}

export function fmtSize(n) {
  if (n === null || n === undefined) return '未知大小';
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 ** 2).toFixed(1)}MB`;
}
