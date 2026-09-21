# OPERATIONS —— 部署与运维

目标机器：一台跑 Docker 的服务器（示例按 2 核/1.6G 级别的最小配置写，机器再小就要收紧
`config.limits` 里的配额）。容器 `larkrelay` 只绑 `127.0.0.1:8310`，数据在 `/data/larkrelay/`，
发布件在 `/opt/larkrelay/releases/<sha>` + `current` 符号链接。

所有命令均在你自己的机器上用 PowerShell 执行，仓库根目录假设为本仓库的 checkout 路径。
下面的命令用 `ssh`/`scp` 写，别名 `larkrelay-host` 建议配进你本机的 `~/.ssh/config`；
如果你用别的远程执行工具（例如内部运维脚本的包装器），把 `scripts/deploy.ps1` 的
`-UploadCmd`/`-RunCmd` 参数指过去即可，命令形状原样照抄。

## 前提

- **SSH 访问建议限制在你信任的来源 IP**（安全组/防火墙白名单），不要对公网开放。
- 一切远程操作走 `ssh`/`scp`（或你自己的包装器），避免把密钥、明文命令散落在 shell 历史里。
- 复杂/带重定向的命令一律「本地写 .sh → 上传 → 远程执行 `sh /tmp/x.sh`」（`deploy.ps1` 就是这么处理
  `nohup ... > log 2>&1 &` 的）——有些包装工具转发命令时会把 `&&`/`>`/`<`/`|` 这类字符剥坏，
  拆成小脚本能绕开这一整类问题。
- 明文 IP、密码、密钥不进任何命令行参数、文档或 commit——本文档里没有，也不要加。
- 本地需要：Windows 10+ 自带 `tar`、PowerShell（不依赖 Git Bash）、Node 24（跑 `npm test`，与部署无关）。

## 首次安装

```powershell
# 1) 建目录、定权限、查 docker
scp deploy\remote-install.sh larkrelay-host:/tmp/remote-install.sh
ssh larkrelay-host "sh /tmp/remote-install.sh"
# 期望看到：releases 目录、data 4 个子目录、/data/larkrelay 权限 1000:1000 755、
# config 权限 1000:1000 700、docker 版本号
```

```powershell
# 2) 装 secrets.json（本地先从 secrets.example.json 复制一份，填真实 app_secret/admin_token，
#    ws 模式下 encrypt_key/verification_token 留空；这份本地文件绝不 git add，用完可删）
scp <本地 secrets.json 路径> larkrelay-host:/tmp/secrets.json
scp deploy\install-secrets.sh larkrelay-host:/tmp/install-secrets.sh
ssh larkrelay-host "sh /tmp/install-secrets.sh"
# 期望看到 sha256 与 -rw------- 1000 1000，不会打印内容
```

```powershell
# 3) 装 config.json（非密，可以直传目标路径；从 config.example.json 改 app_id/teacher_open_id，
#    transport 先留 "ws"）
scp <本地 config.json 路径> larkrelay-host:/data/larkrelay/config/config.json
ssh larkrelay-host "chown 1000:1000 /data/larkrelay/config/config.json"
ssh larkrelay-host "chmod 644 /data/larkrelay/config/config.json"
```

```powershell
# 4) 首次部署（会跑第一次 docker build，耗时最长）
.\scripts\deploy.ps1
```

看到 `== 部署成功：sha=... ==` 即完成。用「看健康」一节的命令再确认一遍。

## 日常部署

```powershell
git add -A; git commit -m "..."     # 部署前先提交：pack.ps1 用 HEAD 短 sha 当版本号，
                                     # 不提交就打包，tag 和实际代码对不上，回滚也认不出版本
.\scripts\deploy.ps1
```

`deploy.ps1` 会自己打包、上传、后台起 `remote-deploy.sh`、每 10 秒轮询一次日志，最多等 10 分钟，
看到 `DEPLOY_EXIT=0` 就是成功；`DEPLOY_EXIT=1` 说明健康检查没过、脚本已经自动回滚到上一个
release 并重新拉起，日志里会写明回滚后是否健康。

## 回滚

```powershell
# 1) 看还有哪些 release 可选
ssh larkrelay-host "ls -1 /opt/larkrelay/releases"

# 2) 回滚（不重新 build，同步执行，几十秒内出结果；不需要 deploy.ps1 那套后台轮询）
scp deploy\remote-rollback.sh larkrelay-host:/tmp/remote-rollback.sh
ssh larkrelay-host "sh /tmp/remote-rollback.sh <sha>"
# 看 ROLLBACK_EXIT=0
```

回滚要求 `larkrelay:<sha>` 镜像还在本地——`remote-deploy.sh` 只自动保留最近 5 个 release
及其镜像，更早的版本要回滚得先 `ssh larkrelay-host "sh /tmp/remote-deploy.sh <sha>"`
重新 build（前提是 `/tmp/larkrelay-<sha>.tgz` 还在，或者重新 `scripts\pack.ps1` 后上传）。

## 看日志

```powershell
ssh larkrelay-host "docker logs --tail 200 larkrelay"
```

## 看健康

```powershell
# 容器自带 healthcheck 的状态（最推荐，不依赖宿主机是否装了 curl/wget；
# {{json .State.Health}} 没有空格，不用再套一层引号）
ssh larkrelay-host "docker inspect --format {{json .State.Health}} larkrelay"

# 直接打 /healthz（宿主机若有 curl）
ssh larkrelay-host "curl -s http://127.0.0.1:8310/healthz"

# 容器运行状态 + 资源（两条分开跑）
ssh larkrelay-host "docker ps --filter name=larkrelay"
ssh larkrelay-host "docker stats --no-stream larkrelay"

# 磁盘（附件配额见 config.limits）
ssh larkrelay-host "df -h /"
ssh larkrelay-host "du -sh /data/larkrelay/files"
```

`/healthz` 的字段（`src/health/state.mjs`）里最该盯的是 `wsState`（长连接是否 connected）、
`lastEventAt`（最后一次真收到事件的时间）、`missed24h` 与 `splitSuspect`（对账发现漏消息或
疑似有人在别处抢同一应用的事件）。启用了用户身份归档的话，还要盯 `user_identity` 和
`archive` 这两段，见下一节。

## 用户身份

归档线（补「别人私聊你本人」这部分消息的那条线，见 `docs/SETUP.md` 第 5 步）靠用户身份的
令牌活着。令牌一断本来是**静默漏数据**——没人会主动告诉你哪条消息没收到；现在这条线出问题
会主动发消息提醒（见下面「主动提醒」），但 `/healthz` 里的字段仍然是排查时最终的依据。

### 看状态

```powershell
ssh larkrelay-host "docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml exec larkrelay node bin/relay.mjs health"
```

看输出里的「用户身份」「归档线」两行；或者直接看 `/healthz` 的 `user_identity` 段：

| 字段 | 含义 |
|---|---|
| `authorized` | 现在能不能用；`false` 时看 `reason` |
| `reason` | 只在没授权成功时出现；`never_authorized` = 从没走过授权流程 |
| `dead` | 有值就是令牌已判死，值是判死原因；正常应为 `null` |
| `reauth_due_at` / `reauth_due_in_days` | 距离官方 365 天硬顶还有多久 |
| `reauth_warning` | 剩不到 30 天时变 `true`，该准备重新走一次授权了 |
| `scope` | 当前令牌实际拿到的权限 |

### 主动提醒（不再只写日志）

这条线出问题现在会**主动发消息给主人**，不用盯着 `/healthz` 才发现。三种情形，各自独立
冷却（不共用同一个倒计时，理由见下面的设计约束）：

| 情形 | 冷却 | 消息里带什么 |
|---|---|---|
| 令牌已判死（`dead` 有值） | 6 小时 | 说明漏的是「别人私聊你本人」这半边，机器人那半边不受影响，附一条可点的授权链接 |
| 距 365 天硬顶不到 30 天（`reauth_warning: true`） | 24 小时 | 还剩多少天、到期当天会静默停止归档，附一条可点的授权链接 |
| 归档连续失败 3 次（`archive.fail_streak >= 3`） | 6 小时 | 连续失败的次数与最近一次的错误信息 |

**设计约束，改代码时别踩**：

- 各类告警（包括长连接、对账这些跟用户身份无关的告警）**按种类各自维护一个冷却计时器，
  不能共用一个**——否则一条连接告警会把这里更要紧的令牌提醒压掉，用户就永远收不到。
- 这几类「只提醒、不判死」的检查**排在所有会导致进程重启的判死分支之前**执行。判死分支
  会直接 `return`；如果顺序反过来，「连接挂了」会顺手把「用户身份静默失效」这条提醒一起
  吞掉——而这条提醒恰恰是唯一能让人发现问题的地方，一个故障不该掩盖另一个通知。

### 重新授权

现在推荐的路径是**在飞书对话里做完**，因为上面这几条提醒是在手机上看到的，手边通常没有
终端：

1. 令牌判死或临近 365 天硬顶时，机器人会按上表主动发提醒，消息里直接带可点的授权链接；
   也可以不等提醒，随时在你和机器人的私聊里发「**授权**」两个字（`重新授权` / `auth` /
   `reauth` 也认）主动要一条。
2. **用你本人的飞书账号**打开链接、点「同意」（**链接 30 分钟内有效**，过期了再要一条新的）。
3. 浏览器会跳到一个**打不开的地址**，这是正常的——把**地址栏整条**复制，直接发回同一个
   对话。
4. 机器人自己完成授权，回一条「授权成功」；`user_identity.authorized` 变回 `true`、
   `dead` 变回 `null`。不需要先清掉旧状态，新一轮授权会直接覆盖旧令牌。

**这条通道的边界很窄，按设计**：只认主人本人、只认与机器人的私聊（`chat_type=p2p`）、只认
两种消息形状——单独一句「授权」类的词，或者一条含 `code=` 的回调链接。别人在别处贴一模一样
的链接不会触发任何事。

命令行做法仍然可用（脚本化、或没有聊天上下文时）：

```powershell
ssh larkrelay-host "docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml exec larkrelay node bin/relay.mjs auth"
```

打印出的链接同样用你本人的账号打开、点同意；如果走的是默认的本地回调（见
`docs/SETUP.md` 第 5.1 步），把地址栏整条复制后改用：

```powershell
ssh larkrelay-host "docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml exec larkrelay node bin/relay.mjs auth --callback-url '<粘在这里>'"
```

看到「授权成功」，或者 `user_identity.authorized` 变回 `true`、`dead` 变回 `null`，就是通了。

### 令牌失效的症状

- `/healthz` 返回 503，`user_identity.authorized: false` 且 `dead` 有值
- 归档线报错：`archive.fail_streak` 持续增长，`archive.last_error` 里能看到具体原因
  （常见是「用户令牌已失效」「refresh_token 已过期」）
- 该以你本人名义发的回复被**降级成机器人名义**发出（对方收到的署名不对），主人会另收到
  一条说明降级原因的提醒消息

### 手动触发归档

平时归档按 `config.archive.interval_sec`（默认 300 秒）自动跑，不需要手动介入。怀疑漏了、
等不及下一轮时手动催一次：

```powershell
ssh larkrelay-host "docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml exec larkrelay node bin/relay.mjs archive"
```

（等价的管理接口是 `POST /api/archive`。）输出里的会话数、扫描条数、补录条数、失败会话数
能看出这一轮归档做了什么；`mode` 是当前的会话发现方式——`list`（直接列出会话）或
`contacts`（按已知联系人逐个解析单聊，见 README「用户身份的四条限制」第 3 条）。

**首次见到一个会话时，起点不是「现在」**：用的是 `config.archive.backfill_days`
（默认 30 天）往前回溯，跟补断线漏消息用的 `reconcile.overlap_sec`（十分钟量级）是刻意
分开的两个参数——早期版本混用过，后果是账面显示「N 个会话成功」，实际上刚上线只收进了
最近十分钟，历史全空（见 README「用户身份的四条限制」第 4 条）。**注意单个会话的历史
翻页上限是 20 页 × 50 条 = 1000 条**，`backfill_days` 开得比这个上限对应的消息量还大、
老会话又活跃的话，更早的部分会被截断收不进来。

## 手动补录

**里程碑 1 现状：没有带自定义时间范围的手动补录管理接口**（`bin/relay.mjs`、`/admin/*` 尚未实现，
`secrets.admin_token` 是为它预留的）。日常的漏收由进程自带的对账轮询兜底
（`config.reconcile.interval_sec`/`overlap_sec`，见 `docs/DECISIONS.md`），不需要手动介入。

只有怀疑漏收窗口**超过** `overlap_sec`（默认 600 秒）才需要人工处理，目前只能这样绕：

```powershell
# 1) 先确认真的漏了：看健康里的 missed24h / splitSuspect，或直接查 DB。
#    DB 查询是带引号的复杂命令，按前面的约定本地先落成一个小脚本再传上去跑，
#    不要把它拼成一整条远程命令的参数。
@'
docker exec larkrelay node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/larkrelay/db/relay.sqlite');console.log(db.prepare('select count(*) as n, max(created_at) as latest from messages').get())"
'@ | Set-Content -Path $env:TEMP\larkrelay-check-db.sh -Encoding ascii -NoNewline
scp $env:TEMP\larkrelay-check-db.sh larkrelay-host:/tmp/check-db.sh
ssh larkrelay-host "sh /tmp/check-db.sh"

# 2) 临时把 config.json 里 reconcile.overlap_sec 调大（比如覆盖过去 24 小时改成 90000），
#    重新上传、重启容器；跑完一轮对账（等 interval_sec 一个周期）后改回默认值再重启一次
scp <改过的 config.json> larkrelay-host:/data/larkrelay/config/config.json
ssh larkrelay-host "docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml restart larkrelay"
```

TODO：`bin/relay.mjs` 或管理接口落地后，把这一节换成直接调接口，不用再靠改配置重启绕。

## 切 webhook 模式的完整步骤

**里程碑 1（长连接 ws）默认不启用 webhook，`deploy/Caddyfile.snippet` 也不要贴进正式反代配置。**
只有长连接不可用、必须切换时才做以下步骤：

1. 飞书开发者后台：把「事件与回调」的订阅方式从「使用长连接接收事件」改成
   「将事件发送至开发者服务器」，请求网址填你自己域名下的 `/lark/events`（例如
   `https://lark.example.com/lark/events`），记下 Verification Token / Encryption Key
   （如果还没生成，控制台会给）。
2. 更新 secrets：把 `verification_token`、`encrypt_key` 填进本地 secrets.json 副本，走
   `install-secrets.sh` 那套流程重新装一遍（见「首次安装」第 2 步）。
3. 更新 config：本地 config.json 把 `transport` 改成 `"webhook"`，重新上传到
   `/data/larkrelay/config/config.json`（同「首次安装」第 3 步）。
4. 部署反向代理配置前**先验证语法**（以 Caddy 为例）：
   ```powershell
   ssh larkrelay-host "caddy validate --config /etc/caddy/Caddyfile"
   ```
   把 `deploy/Caddyfile.snippet` 的内容改成你自己的域名后贴进正式配置，再跑一遍上面这条，通过了才继续。
5. **日志文件必须先建好、属主正确**（这类反代踩过这个坑：文件不存在或属主不对，不会自己修好权限）：
   ```powershell
   ssh larkrelay-host "touch /var/log/caddy/lark.example.com.log"
   ssh larkrelay-host "chown caddy:caddy /var/log/caddy/lark.example.com.log"
   ```
6. 用 `systemctl reload caddy`（不要 `restart`，减少切换期间的连接中断）：
   ```powershell
   ssh larkrelay-host "systemctl reload caddy"
   ```
7. 重启 larkrelay 容器让新 config.json 生效（镜像没变，不需要重新 build）：
   ```powershell
   ssh larkrelay-host "docker compose -f /opt/larkrelay/current/deploy/docker-compose.yml restart larkrelay"
   ```
8. 验证：飞书里发一条测试消息给机器人，看「看健康」一节的 `lastEventAt` 是否更新，
   `docker logs` 里应该能看到收到事件的记录。
9. 回退：把上面 1/3 反过来（订阅方式改回长连接、config.json 的 transport 改回 `"ws"`），
   重启容器；建议同时把反代配置里的这段摘掉或注释掉，收窄公网暴露面。

## 人工归档附件（按月 tar + download + 删远端）

附件落在 `/data/larkrelay/files/YYYY/MM/<message_id>/`（`docs/DECISIONS.md` 决定 4：
附件是证据，里程碑 1 不自动删）。磁盘紧张时按月手工搬走：

```powershell
# 1) 服务器上按月打包（用变量替换年月，例如 2026 09）
ssh larkrelay-host "tar -czf /tmp/larkrelay-files-2026-09.tgz -C /data/larkrelay/files 2026/09"

# 2) 下载到本地妥善保存的位置（不要落在仓库里）
scp larkrelay-host:/tmp/larkrelay-files-2026-09.tgz D:\Archives\larkrelay\larkrelay-files-2026-09.tgz

# 3) 校验本地包完整（能列出内容就算过）
tar -tzf D:\Archives\larkrelay\larkrelay-files-2026-09.tgz | Select-Object -First 5

# 4) 确认无误后，先删服务器上的临时 tar，再单独、谨慎地删原始月份目录
#    （这一步是数据删除，先确认第 3 步真的能打开、内容对得上再做，不要图快连着 3/4 步一起跑）
ssh larkrelay-host "rm -f /tmp/larkrelay-files-2026-09.tgz"
ssh larkrelay-host "rm -rf /data/larkrelay/files/2026/09"
```

## 故障排查表

| 症状 | 可能原因 | 处理 |
|---|---|---|
| `ssh`/`scp` 直接连不上或超时 | 不在允许访问的来源 IP 里，或密钥/别名配置不对 | 检查安全组/防火墙白名单和 `~/.ssh/config` |
| `docker compose build` 很慢或卡住 | 镜像加速器或包管理镜像源抽风 | 换 `--build-arg NPM_REGISTRY=...`；`ssh larkrelay-host "df -h"` 顺手看看磁盘 |
| `DEPLOY_EXIT=1` 且日志显示回滚后仍不健康 | 新旧代码都起不来（常见于 config.json 格式错、secrets 缺字段） | 先 `docker logs --tail 200 larkrelay`，`src/config.mjs` 的报错是中文，直接能定位 |
| 容器一直 `unhealthy` 但进程没崩 | `/healthz` 还没实现，或没监听 `127.0.0.1:8310` | 确认 `src/index.mjs` 已经起 HTTP 服务；这是 healthcheck 生效的前提 |
| 远程命令卡到超时 | 把会长时间跑的操作（如 `docker compose build`）当同步命令直接跑了 | 一律走「写 .sh → 上传 → nohup 后台跑 → 轮询日志」，`deploy.ps1` 已经这么做，不要手动同步跑 build |
| secrets.json 权限不对，或怀疑内容外泄 | 没走 `install-secrets.sh`，或用别的方式传过 | 重新走 `install-secrets.sh`；怀疑外泄立刻考虑轮换 `app_secret` |
| 磁盘快满 | `files/` 附件堆积，或历史 release/镜像没清 | 参考「人工归档附件」；`remote-deploy.sh` 只自动保留最近 5 个 release/镜像，更早的手工清 |
| 长连接一直 `reconnecting` | 网络抖动，或应用在飞书后台被下线/禁用 | 看 `wsState`；同时确认没有第二个消费者在抢同一应用的事件 |
| webhook 模式下反代起不来或不写日志 | 日志文件不存在或属主不对 | 先 `touch` + `chown`，再验证配置语法，最后才 reload |
| `user_identity.authorized=false` 且 `reason=never_authorized` | 用户身份从没授权过 | 走 `docs/SETUP.md` 第 5 步 |
| `user_identity.dead` 有值 | 令牌已判死（服务端拒绝或 refresh_token 过期） | 见「用户身份 → 重新授权」 |
| `archive.fail_streak` 持续增长 | 归档线在失败 | 看 `archive.last_error` 定位原因 |
| 学生/联系人收到的回复署名是机器人而不是你本人 | 用户身份不可用，回复被降级 | 看 `/healthz` 的 `user_identity`，按上面重新授权 |
