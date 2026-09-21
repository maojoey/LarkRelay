-- 群名：卡片抬头要写「来自谁 · 哪个群」，光有 chat_id 看不出是哪儿
ALTER TABLE chats ADD COLUMN name TEXT;
-- 原始会话是不是群：决定回传是发回群里还是私聊本人。
-- 不改 origin_kind 的 CHECK 约束（SQLite 改不动），另开一列表达。
ALTER TABLE routes ADD COLUMN origin_chat_type TEXT;
