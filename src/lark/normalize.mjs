// 三种来源的飞书消息事件 -> 统一内部形状，下游数据层按这固定字段存，别改。
// 输入形状：1) WS/webhook 事件（嵌套 message/sender.sender_id）；2) im.message.list 返回项（扁平，
// sender.id 直接是 open_id）；3) 已 normalize 过的对象（幂等，原样返回）。哪种由结构自动判断，不用调用方指明。

// 机器人自己发的卡片、系统消息等不需要转发给老师，仍正常 normalize 但打个标记，落库判断交给 worker。
const IGNORED_TYPES = new Set(['sticker', 'share_chat', 'share_user', 'merge_forward', 'system', 'interactive']);

// 已 normalize 过的对象只有这条流水线会同时具备这几个字段（含自引用的 raw），拿它当幂等判据。
function isNormalized(raw) {
  return !!raw && typeof raw === 'object'
    && 'sender_open_id' in raw && 'mentions' in raw && 'attachments' in raw && 'raw' in raw;
}

// event 的 mention.id 是 {open_id,...} 对象；list 项的 mention.id 已经是字符串（即 open_id）。
function normalizeMentions(rawMentions) {
  if (!Array.isArray(rawMentions)) return [];
  return rawMentions.map((m) => ({
    key: m.key,
    name: m.name,
    open_id: typeof m.id === 'string' ? m.id : (m.id?.open_id ?? null),
  }));
}

// post 消息按语言取一段 content[][]，团队场景基本只会填一种语言；zh_cn 优先，否则取第一个有内容的。
function pickPostLang(post) {
  if (!post) return null;
  return post.zh_cn ?? post.en_us ?? Object.values(post)[0] ?? null;
}

function extractText(msgType, obj, mentions) {
  if (obj == null) return null;
  if (msgType === 'text') {
    const t = obj.text;
    if (t == null) return null;
    return mentions.reduce((acc, m) => (m.key ? acc.split(m.key).join(`@${m.name}`) : acc), t);
  }
  if (msgType === 'post') {
    const lang = pickPostLang(obj.post);
    if (!lang?.content) return null;
    return lang.content
      .map((line) => line.map((el) => {
        if (el.tag === 'text') return el.text ?? '';
        if (el.tag === 'a') return `「${el.text ?? ''}」(${el.href ?? el.url ?? ''})`;
        if (el.tag === 'at') return `@${el.user_name ?? el.name ?? ''}`;
        return '';
      }).join(''))
      .join('\n');
  }
  return null;
}

function extractAttachments(msgType, obj) {
  if (obj == null) return [];
  if (msgType === 'image') {
    return obj.image_key ? [{ file_key: obj.image_key, kind: 'image', file_name: null }] : [];
  }
  if (msgType === 'file' || msgType === 'audio' || msgType === 'media') {
    // media（视频）的封面 image_key 不算附件，忽略。
    return obj.file_key ? [{ file_key: obj.file_key, kind: 'file', file_name: obj.file_name ?? null }] : [];
  }
  if (msgType === 'post') {
    const lang = pickPostLang(obj.post);
    const atts = [];
    for (const line of lang?.content ?? []) {
      for (const el of line) {
        if (el.tag === 'img' && el.image_key) atts.push({ file_key: el.image_key, kind: 'image', file_name: null });
      }
    }
    return atts;
  }
  return [];
}

function toIntTime(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// 拆出两种来源各自的原始字段，统一成一份中间表示，后面的抽取逻辑不用再关心来自哪。
function pickRawFields(raw, chatType) {
  if (raw && typeof raw.message === 'object' && raw.message !== null) {
    const m = raw.message;
    return {
      messageId: m.message_id,
      chatId: m.chat_id,
      chatType: m.chat_type,
      msgType: m.message_type,
      contentStr: m.content,
      createTimeRaw: m.create_time,
      replyTo: m.parent_id ?? m.reply_to ?? null,
      rootId: m.root_id ?? null,
      threadId: m.thread_id ?? null,
      mentionsRaw: m.mentions,
      senderOpenId: raw.sender?.sender_id?.open_id ?? null,
      senderType: raw.sender?.sender_type ?? null,
    };
  }
  // im.message.list 项：扁平字段，没有 chat_type，用调用方传入的第三参数补，缺省 'p2p'。
  return {
    messageId: raw.message_id,
    chatId: raw.chat_id ?? null,
    chatType: chatType ?? 'p2p',
    msgType: raw.msg_type,
    contentStr: raw.body?.content,
    createTimeRaw: raw.create_time,
    replyTo: raw.parent_id ?? raw.reply_to ?? null,
    rootId: raw.root_id ?? null,
    threadId: raw.thread_id ?? null,
    mentionsRaw: raw.mentions,
    // list 接口里 sender.id 就是 open_id（id_type === 'open_id' 时，本项目场景下恒如此）。
    senderOpenId: raw.sender?.id ?? null,
    senderType: raw.sender?.sender_type ?? null,
  };
}

export function normalize(raw, transport, { chatType } = {}) {
  if (isNormalized(raw)) return raw;

  const f = pickRawFields(raw, chatType);
  const mentions = normalizeMentions(f.mentionsRaw);

  let content;
  let parsedOk = true;
  let parsedObj = null;
  try {
    parsedObj = JSON.parse(f.contentStr);
    content = parsedObj;
  } catch {
    parsedOk = false;
    content = f.contentStr;
  }

  const out = {
    message_id: f.messageId,
    chat_id: f.chatId,
    chat_type: f.chatType,
    sender_open_id: f.senderOpenId,
    sender_type: f.senderType,
    msg_type: f.msgType,
    text: parsedOk ? extractText(f.msgType, parsedObj, mentions) : null,
    content,
    reply_to: f.replyTo,
    root_id: f.rootId,
    thread_id: f.threadId,
    create_time: toIntTime(f.createTimeRaw),
    transport,
    mentions,
    attachments: parsedOk ? extractAttachments(f.msgType, parsedObj) : [],
    raw,
  };
  if (IGNORED_TYPES.has(f.msgType)) out.ignore = true;
  return out;
}
