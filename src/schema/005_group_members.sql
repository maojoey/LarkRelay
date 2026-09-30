-- 上游通知拉取器按姓名解析收件人时，除了主人的单聊对端，还要把「同一个群里」的人
-- 算进候选——很多学生没跟主人私聊过，但都在机器人所在的群里。
-- 单独一张表而不是塞进 contacts：contacts 是「认识的人」，这张是「这个群里现在有谁」，
-- 群成员会退群、换群，需要整表按群替换，不能像 contacts 那样只 UPSERT 越攒越多。
CREATE TABLE group_members (
  chat_id TEXT NOT NULL,
  open_id TEXT NOT NULL,
  name    TEXT,
  PRIMARY KEY (chat_id, open_id)
);
