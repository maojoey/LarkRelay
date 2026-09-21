-- 会话表被两条线共用：机器人事件写入的，和用户身份枚举出来的。
-- 两者能读的范围不同——机器人只读得了自己所在的会话，拿机器人身份去拉别人的单聊必然 400。
-- 这一列区分「机器人在不在里面」，对账只拉自己能读的那些。
ALTER TABLE chats ADD COLUMN bot_member INTEGER NOT NULL DEFAULT 0;
