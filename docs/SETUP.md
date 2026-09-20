# 从零跑起来

按顺序做，每步都有「怎么验证做对了」。全程约 30 分钟。

飞书开发者后台**没有命令行接口**，自建应用的创建、权限、事件订阅、发布只能在网页上点。
所以第一步是点，后面全是命令。

## 前置条件

- 一台能跑 Docker 的服务器（示例里假设 2 核 / 1.6GB 级别的最小配置也够用）
- 本地 Node.js ≥ 22.5（跑测试用，与部署无关）
- 一个飞书开发者账号，且有权限在目标租户下创建企业自建应用

---

## 第 1 步：建应用（网页，约 12 分钟）

打开 <https://open.feishu.cn/app>，确认右上角是你要用的租户。

### 1.1 创建

点「创建企业自建应用」：

| 字段 | 填什么 |
|---|---|
| 应用名称 | 随便取一个，比如「消息中转机器人」 |
| 应用描述 | 直接粘下面这段，按需替换称呼 |

```
消息助手。你发给它的消息和文件会被记录，并转给机器人的所有者；
所有者的回复也由它转达。它不是所有者本人，也不会自动回复你。
```

> 这段描述不是客套。学生/同事会默认在跟机器人后面的人说话；
> 描述是唯一把「消息会被系统记录」讲清楚的地方，别删。

### 1.2 加机器人能力

左栏「添加应用能力」→ 找到**机器人**→ 添加。

### 1.3 开权限

左栏「权限管理」，搜索框里逐个搜、逐个「开通」，共 5 项：

```
im:message
im:message:send_as_bot
im:message.p2p_msg:readonly
im:resource
contact:user.base:readonly
```

**验证**：权限管理页面的「已开通权限」列表里能数到这 5 条。

### 1.4 配事件

左栏「事件与回调」→「事件配置」：

1. 订阅方式选 **「使用长连接接收事件」**。
2. **不要填任何回调网址。** 填了就走 webhook 模式，本仓库默认的长连接模式接不上。
3. 点「添加事件」，搜 `im.message.receive_v1`（中文显示「接收消息」），添加。

**验证**：事件列表里有且只有 `im.message.receive_v1`，订阅方式显示长连接。

> 这页如果有「加密策略」（Verification Token / Encrypt Key），**长连接模式下用不到**，可以不管。
> 长连接进来的事件走的是 SDK 的 `needCheck: false` 那条路，校验和解密整段跳过。
> 以后要切成 webhook 模式（见 `docs/OPERATIONS.md`）才需要它们，到时候再回来取。

### 1.5 取 App ID 和 App Secret

左栏「凭证与基础信息」，两个值：

- **App ID**（`cli_` 开头）：非密信息，可以出现在 `config.json` 里。
- **App Secret**：**密钥，只进 `secrets.json`，不要提交到 git，不要贴进任何聊天记录**。

### 1.6 发布

左栏「版本管理与发布」→「创建版本」：

| 字段 | 填什么 |
|---|---|
| 版本号 | `1.0.0` |
| 可用范围 | 先选「仅自己」，验证通过后再逐步放开 |
| 更新说明 | 随便写，例如「初版」 |

保存 → 「申请发布」。如果你是租户管理员，去「管理后台 → 工作台 → 应用审核」把它通过。

**验证**：应用状态显示「已发布」。**没发布的话调任何接口都会报 `app not released`。**

---

## 第 2 步：落地密钥（约 3 分钟）

App Secret 是唯一的敏感信息，全程只经手你自己的终端，不要贴进任何 AI 对话或 issue。

```powershell
$dir = "$env:USERPROFILE\_secrets\larkrelay"    # 放在仓库之外的任意目录都行
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$adminToken = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
@{
  app_secret         = "把开发者后台的 App Secret 粘到这里"
  encrypt_key        = ""
  verification_token = ""
  admin_token        = $adminToken
} | ConvertTo-Json | Set-Content -Path "$dir\secrets.json" -Encoding utf8
notepad "$dir\secrets.json"
```

记事本会弹出来，**把 `app_secret` 那一行的占位文字换成真的 App Secret**，保存关闭。
`encrypt_key` 和 `verification_token` 留空就行（长连接用不到，见 1.4）。
`admin_token` 已经自动生成好了，是 `bin/relay.mjs` 管理接口用的 Bearer token，不用动。

再复制一份 `config.example.json` 为 `config.json`，把 `app_id`、`teacher_open_id`（你自己的 open_id）、
`teacher_name`（想显示的称呼）填成真实值。`config.json` 不含密钥，可以随部署流程一起走版本控制之外的路径。

---

## 第 3 步：部署

把 `secrets.json` 放到服务器上 `/data/larkrelay/config/secrets.json`（600 权限），
`config.json` 放到 `/data/larkrelay/config/config.json`，然后跑：

```powershell
.\scripts\deploy.ps1
```

默认用标准 `scp`/`ssh`（目标写成 `user@host`，或者先在 `~/.ssh/config` 里配好别名再传给 `-VpsAlias`）。
完整的首次安装、日常部署、回滚步骤见 `docs/OPERATIONS.md`。

部署脚本会依次：打包 → 上传 → 后台构建 → 起容器 → 轮询 `/healthz` 直到健康或超时。
成功后确认 `/healthz` 里 `ws_state` 是 `connected`。

---

## 第 4 步：验收（在飞书里做，约 5 分钟）

在你和机器人的私聊窗口里，按顺序做这 5 件事。

| # | 你做什么 | 应该看到什么 |
|---|---|---|
| 1 | 发一句话，比如「测试一」 | 收到一张卡片，抬头「来自 <你的称呼>（自测）· 自环」，正文是你发的话 |
| 2 | 用 `bin/relay.mjs send-text` 从服务端发一条 | 收到服务端发的文字 |
| 3 | 发一个 PDF 和一张图片 | 各收到一张卡片（写着附件已存档），随后收到重新上传的同名文件 |
| 4 | **对第 1 步那张卡片按「回复」**，写「收到」 | 收到「[回传自测] 收到」+ 一条回执「已发给 <你的称呼>（自测）」 |
| 5 | 对一条**不是卡片**的消息按回复 | 收到回执「这条不是转发消息，没有回传对象」 |

第 4 步是整套的核心：它证明「所有者回复卡片 → 内容回到原主」这条路通了。
接入更多联系人后，这条路就是「所有者回复 → 回到那个联系人」。

## 出问题了看哪里

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 调接口报 `app not released` | 1.6 没发布，或发布后没在管理后台通过 | 回 1.6 |
| 机器人搜不到 / 发消息没反应 | 可用范围没包含你自己 | 版本管理里改可用范围，重新发一版 |
| `/healthz` 的 `ws_state` 一直不是 `connected` | 事件订阅没选长连接，或 App Secret 错了 | 回 1.4 核对；看容器日志 |
| 发了消息但没收到卡片 | 事件没订阅上，或被别处分流 | 看 `/healthz` 的 `split_suspect` |
| 回复卡片没回传 | 回复的不是卡片而是别的消息 | 看回执说了什么 |

日常运维命令全在 `docs/OPERATIONS.md`；踩过的坑和怎么防见 `docs/PITFALLS.md`。
