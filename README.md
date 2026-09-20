# LarkRelay

**飞书 / Lark 的人对人消息中转：别人私聊机器人 → 转发到你的私聊 → 你回复那条 → 自动回传给对方。**

> **English**: A human-to-human message relay for Feishu / Lark. People DM your bot; the bot forwards
> each message as a card into *your* private chat with it; you hit **reply** on that card and your words
> go straight back to the original sender. Messages and attachments are archived to SQLite.
> Long-connection (WebSocket) by default, webhook as a fallback, single Docker container, no runtime
> dependency beyond the official SDK. See [docs/SETUP.md](docs/SETUP.md) to get started.

---

## 为什么会有这个项目

找过一圈，飞书生态里**没有**现成的实现。GitHub 上 `feishu-bot` 话题 169 个仓库、`feishu` 话题
star 过百的 50 个，翻下来只有三类东西：

| 类别 | 在做什么 |
|---|---|
| 接大模型的问答机器人 | 用户说话 → 模型回答 |
| 接本地编码智能体的桥 | 飞书当远程终端，消息喂给编码 CLI |
| 单向通知推送 | 告警、日报转发进群 |

**没有一个是「人 ↔ 机器人 ↔ 人」。** 这个模式在 Telegram 生态里很常见（`feedback-bot` 话题下
十几个实现），但那边的动机是**隐藏管理员身份**；飞书这边一个都没有。

本项目填的就是这个空。典型场景：

- 老师 / 助教收学生提问和作业，材料自动归档，回复不用切工具
- 社群主理人收反馈，所有对话集中在一个窗口
- 任何「多对一」的收件场景，需要留档、附件落盘、统一回复入口

## 一个必须先说清楚的前提

**机器人看不到别人私聊你本人的消息。** 这是所有 IM 的规则，不是飞书的限制。

所以本项目的前提是：**让对方去私聊机器人**，而不是私聊你。如果你要的是「读到所有发给我本人的
消息」，那不该用机器人，应该用**用户身份**授权后读自己的会话（`im:message.p2p_msg:get_as_user`
这类用户权限）。两件事，别混。

## 它做什么

四个原语，外加一条路由：

1. 别人私聊机器人（或在群里 @ 它）→ 消息与附件落库
2. 机器人把它做成一张**卡片**转发到你和机器人的私聊，抬头写清「来自谁 · 哪条线」
3. 附件自动下载存盘，并重新上传一份发给你
4. **你对那张卡片按「回复」→ 内容原样回传给最初发消息的人**，并给你一条「已发给 X」回执
5. 你也可以通过命令行或 HTTP 接口主动发消息和文件

### 三条护栏（不是可选项）

你的私聊里会堆着来自不同人的转发卡片，**回错人是这类系统最容易出的事故**。所以：

- 转发一律用卡片，抬头必须写清来自谁
- **只认带「回复」的消息**。你在私聊里裸打一行字，系统当备忘，不会转发给任何人
- 每次回传都回一条带收件人姓名的回执

## 架构

```
                    飞书开放平台
                      │   ▲
       事件（长连接，默认）│   │ OpenAPI：发消息 / 上传 / 下载 / 拉历史
       或 HTTPS webhook   │   │
                      ▼   │
┌─────────────────────────┴──────────────────────────────────┐
│  单容器，只绑 127.0.0.1:8310                                 │
│                                                             │
│  transport/ws ────┐                                         │
│  transport/webhook ┼─▶ normalize() ─▶ handleEvent()         │
│  health/reconcile ─┘   三种来源，一套处理   │ 只去重落库       │
│      定时对账，补录漏掉的                    ▼                │
│                                        messages(new)        │
│                                              │              │
│                                         core/worker         │
│                    ┌─────────────────────────┼────────────┐ │
│                    ▼                         ▼            ▼ │
│              下载附件                 生成转发卡片      回复路由  │
│                                              │   reply_to→routes│
│                                   core/outbox（幂等 + 退避重试）│
│                                                              │
│  http：/healthz、/api/*（Bearer）、/lark/events（webhook 时）  │
│  watchdog：该重启就 exit(1)，交给 Docker 拉起                  │
└──────────────────────────────────────────────────────────────┘
        │ 数据卷：config / db / files / outgoing
```

三种消息来源（长连接、webhook、定时对账）**共用同一个 `handleEvent`**，所以切换传输方式不会
改变行为。`handleEvent` 只做去重落库然后立刻返回，下载和发送都在异步 worker 里做，
这样 webhook 的 3 秒超时永远不会被触发。

## 快速开始

四份文档，按顺序看：

| 文档 | 内容 |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | 从零跑起来：飞书后台建应用、权限、部署、验收 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 日常运维：部署、回滚、看日志、排错、切 webhook |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 为什么这么设计，以及为什么不用现成项目 |
| [docs/PITFALLS.md](docs/PITFALLS.md) | 开发中真实踩到的五个坑，每个都带根因与防法 |

本机跑测试：

```bash
npm install
npm test        # 56 项，全部离线
```

本机起一个不连飞书的实例（用内置的假 API 实现）：

```bash
RELAY_CONFIG=./config.json RELAY_SECRETS=./secrets.json node src/index.mjs
```

**`RELAY_LIVE` 不置为 `1` 时不会建立任何连接。** 这是个刻意的门闩，理由见下一节。

## 一条容易踩死的规则

**同一个飞书应用的事件订阅只能有一个消费者。**

长连接模式下，同一应用的多个活跃连接之间事件是**分流**的，不是广播。两个地方同时消费，
消息就被随机分走一半，而连接状态一切正常，症状是「偶尔丢消息」，极难排查。

所以：给本项目**单独建一个飞书应用**，不要和别的机器人共用；本机的命令行工具也不要对
同一个应用跑事件消费。`RELAY_LIVE` 门闩能防住本项目自己，但管不住别的工具，靠约定。

配套兜底是**定时对账**：每 5 分钟拉一次会话历史与库里比对，漏掉的补录进来。如果发现
「连接一切正常却仍在漏消息」，会直接报出「疑似有第二个消费者」。

## 技术栈与资源

| 项 | 值 |
|---|---|
| 运行时 | Node 22.5+（生产用 24） |
| 运行时依赖 | 只有 `@larksuiteoapi/node-sdk` 一个 |
| 存储 | SQLite，用 Node 内置的 `node:sqlite`，**无原生模块**，不需要编译器 |
| 镜像 | 约 389MB（基于 `node:24-bookworm-slim`，不装任何 apt 包） |
| 内存 | 实测常驻约 66MB，容器限 256MB |
| 测试 | 56 项，全部离线 |

选 `node:sqlite` 而不是 `better-sqlite3`，是因为后者构建时要拉预编译二进制，slim 镜像里没有
编译器，网络一抖构建就废。内置模块零依赖，构建永远可重现。

## 安全边界

- **密钥只在服务器**，`600` 权限，仓库里只有 `*.example.json`；日志做了脱敏。
- **管理接口只绑 `127.0.0.1`**，全部要 Bearer 令牌；`/healthz` 免鉴权但只读。
- **出站文件只能来自 `outgoing/` 目录**，接口做路径规范化，防目录穿越。
- **附件三道闸**：单文件上限、软硬配额、磁盘剩余下限。摘要流式计算，不把文件整份读进内存。
- **不要把收到的消息喂给有文件系统权限的智能体。** 陌生人发来的文本是不可信输入，
  接进能跑命令的 agent 等于把提示注入直接送进去。本项目刻意做成「哑」的：只转发和归档；
  要让 AI 参与，就让它按需来读库。

## 状态

第一个里程碑（你与机器人之间双向收发文字与文件）代码完成，测试全绿，部署管线在真实服务器上
验证通过。后续方向：把收到的消息按来源分流到下游系统、卡片状态回写「已回复」。

Issue 和 PR 都欢迎。如果你也在找这个东西却没找到，那我们遇到的是同一个问题。

## 许可证

MIT
