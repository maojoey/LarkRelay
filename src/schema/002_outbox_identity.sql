-- 出站消息可以用两种身份发：
--   bot   —— 机器人自己说话（默认，向后兼容既有行数据）
--   owner —— 以主人本人的名义发（需要用户身份授权），对方看到的是真人回复
ALTER TABLE outbox ADD COLUMN identity TEXT NOT NULL DEFAULT 'bot';
