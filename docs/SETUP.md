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

### 1.7 用户身份权限（可选，要归档「别人私聊你本人」的消息才需要）

机器人那 5 项权限只能看到「别人私聊机器人」的消息。如果还想归档「别人私聊你本人」的消息
（机器人天生看不到这条，见 [README.md](../README.md)「一个必须先说清楚的前提」），
回到「权限管理」页面，再开通这 6 项**用户权限**（和机器人权限在同一个搜索框里搜，只是类型
不同）：

```
im:message:readonly
im:message.p2p_msg:get_as_user
im:message.group_msg:get_as_user
im:chat:read
contact:user.base:readonly
offline_access
```

`offline_access` 是关键：没有它换不出 `refresh_token`，令牌两小时后就失效，没法长期归档。

外加一项，**只有需要「以你本人名义回复」时才开**（只做归档、不打算用这个功能可以不开）：

```
im:message.send_as_user
```

**验证**：已开通权限列表里能看到这 6～7 条（取决于要不要 `send_as_user`）。

### 1.8 配重定向 URL（同上，可选）

**不需要是公网地址**，填 `http://localhost:8310/lark/oauth/callback` 即可，原因见第 5 步。

左栏「安全设置」（有的版本叫「重定向 URL」单独一页），加一条：

```
https://example.com/lark/oauth/callback
```

把 `example.com` 换成你服务器的真实域名，路径要跟后面 `config.json` 里的
`oauth.redirect_uri` **逐字一致**——协议、域名、路径、结尾有没有斜杠，一个字符不对都会在
授权回调时报错。

**验证**：安全设置页面里能看到这条 URL 已保存。

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

**要做第 1.7/1.8 步的用户身份归档，还要填 `oauth.redirect_uri`**（跟安全设置里配的那个 URL 逐字一致）；
不用这个功能就把整个 `oauth` 段留成 `config.example.json` 里的默认样子，`archiver` 不会被启用。

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

---

## 第 5 步：完成用户身份授权（可选，要归档才需要）

前提：第 1.7/1.8 步已经开好用户权限、配好重定向 URL，`config.json` 里 `teacher_open_id`
和 `oauth.redirect_uri` 都是真实值，服务已经部署（第 3 步）。

### 5.1 默认做法：不需要对公网开任何口

**授权码在浏览器跳转时就明文躺在地址栏里**，所以重定向地址可以填
`http://localhost:8310/lark/oauth/callback` —— 跳转落到**操作者自己的机器上**，
那里没东西监听、页面直接报错都无所谓，把地址栏整条复制回来即可。

这样整个服务保持**零入站端口**：长连接是出站的，管理接口只绑 `127.0.0.1`。
全程也没有任何第三方碰得到授权码。

> 若开发者后台不接受 `http://` 或 `localhost`（有的平台强制 https），就填一个**你自己拥有的
> 域名**下的路径。同样**不需要真的去服务那个地址**，效果一样；只是别填你不控制的域名，
> 否则授权码会落到别人手里。

无论走哪条，安全都靠同样的三层校验，不靠「地址没人知道」这种脆弱假设：

1. 必须先由主人（带 admin token）发起过一次授权，才会生成一个等待被核对的 `state`；
2. `state` 必须命中且未过期，核对完立刻作废，重放没用；
3. 换到令牌后会回查这个令牌到底是谁的，`open_id` 必须等于配置里的 `teacher_open_id`，
   不是就拒绝、不落盘。

即便授权码本身被截获也没用——没有 App Secret 换不出令牌。

### 5.1b 可选：把回调接到公网做成自动的

嫌复制地址栏麻烦的话，可以把 `oauth.callback_path`（默认 `/lark/oauth/callback`）
经反向代理暴露出去，**只放行这一条路径**，其余一律不转发；`oauth.redirect_uri` 相应改成
那个公网地址。反代配置方法见 `docs/OPERATIONS.md`「切 webhook 模式的完整步骤」一节
（先 `validate` 语法、日志文件先建好再 `reload`）。

**这是纯粹的便利性取舍**：省掉一次复制粘贴，换来一个对外开放的路径。校验逻辑两条路完全一样。

### 5.2 发起授权：在飞书对话里做（推荐）

现在推荐的做法是**全程在飞书对话里完成**，不用登服务器——授权提醒本来就是在手机上看到的，
手边通常没有终端：

1. 在你和机器人的私聊窗口里发「**授权**」两个字（`重新授权` / `auth` / `reauth` 也认），
   机器人会回一条消息，里面直接带一条可点的授权链接（**30 分钟内有效**，过期了再发一次
   「授权」拿新的一条）。
2. **用你本人的飞书账号**打开链接、点「同意」。换别人的账号点同意会被拒绝——服务端会核对
   `open_id`。

这条通道**只认主人本人、只认与机器人的私聊、只认这两种消息形状**：单独一句「授权」类的词，
或者一条含 `code=` 的回调链接（见 5.2b）。别人在别处贴一模一样的指令词或链接，什么都不会
发生。

### 5.2b 把地址栏粘回来

点完同意，浏览器会跳到 `oauth.redirect_uri`。**那个地址打不开是正常的**，
授权码就在地址栏里。把地址栏**整条**复制下来：

```
http://localhost:8310/lark/oauth/callback?code=一串字符&state=另一串字符
```

**直接把这条地址粘回刚才那个对话**，机器人自己完成授权，回一条「授权成功」，就完成了。

（若走 5.1b 把回调接到了公网，这一步自动完成，不需要手动粘。）

### 5.2c 命令行做法（仍然可用，适合脚本化或没有聊天上下文时）

```powershell
ssh larkrelay-host "docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml exec larkrelay node bin/relay.mjs auth"
```

会打印一个链接，同样**用你本人的飞书账号**打开、点「同意」。跳转后把地址栏整条复制下来，
这次不粘进对话，改用：

```powershell
ssh larkrelay-host "docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml exec larkrelay node bin/relay.mjs auth --callback-url '<粘在这里>'"
```

看到「授权成功」就完成了。两条路径（对话里粘 / 命令行传 `--callback-url`）走的是同一套
服务端校验，选哪条纯看手边有没有终端。

### 5.3 验证

```powershell
ssh larkrelay-host "docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml exec larkrelay node bin/relay.mjs health"
```

看到「用户身份　已授权，NNN 天后需重新授权」就是通了；也可以直接看 `/healthz` 里
`user_identity.authorized` 是不是 `true`。

## 用户身份的四条限制

启用第 5 步之前先知道，都是官方接口的限制，不是本项目能绕过的（细节见
[README.md](../README.md)「用户身份的四条限制」）：

1. **365 天硬顶**：满 365 天必须重新走一遍第 5 步，刷新再勤也推不掉。
2. **令牌只能有一个持有者**：`refresh_token` 一次性，不要在别的地方对同一份授权再刷新一次。
3. **单聊会话可能枚举不到**：官方接口不保证列出单聊，本项目会自动降级为按联系人解析，
   降级后只覆盖已知的人。
4. **首次归档要回溯一段历史，回溯太久会被截断**：用的是 `archive.backfill_days`
   （默认 30 天），不是补断线漏消息用的 `overlap_sec`；单会话历史翻页上限 20 页 × 50 条
   = 1000 条，回溯窗口别开得比这个上限还夸张。

## 出问题了看哪里

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 调接口报 `app not released` | 1.6 没发布，或发布后没在管理后台通过 | 回 1.6 |
| 机器人搜不到 / 发消息没反应 | 可用范围没包含你自己 | 版本管理里改可用范围，重新发一版 |
| `/healthz` 的 `ws_state` 一直不是 `connected` | 事件订阅没选长连接，或 App Secret 错了 | 回 1.4 核对；看容器日志 |
| 发了消息但没收到卡片 | 事件没订阅上，或被别处分流 | 看 `/healthz` 的 `split_suspect` |
| 回复卡片没回传 | 回复的不是卡片而是别的消息 | 看回执说了什么 |

日常运维命令全在 `docs/OPERATIONS.md`；踩过的坑和怎么防见 `docs/PITFALLS.md`。
