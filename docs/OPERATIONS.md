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
疑似有人在别处抢同一应用的事件）。

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
