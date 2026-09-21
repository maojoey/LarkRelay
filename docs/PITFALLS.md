# 踩过的坑

开发和部署过程中真实踩到的问题，记下来避免重蹈覆辙。每条：现象 / 根因 / 怎么修 / 怎么防。

## 1. Windows 上自启守卫恒假，容器空转且日志安静

**现象**：容器起来之后什么都不做——不建立长连接、不处理消息，`docker logs` 却一片安静，
没有任何报错。健康检查（`/healthz`）看起来也正常，只是进程实际上什么都没干。

**根因**：Node 里常见的「本文件是不是被直接执行」判断写成手拼字符串比较：

```js
if (`file://${process.argv[1]}` === import.meta.url) { /* 启动 */ }
```

在 Windows 上，`process.argv[1]` 是 `D:\app\src\index.mjs` 这种反斜杠路径，手拼出来的
`file://D:\app\src\index.mjs` 和 `import.meta.url` 实际产出的 `file:///D:/app/src/index.mjs`
差一个斜杠、分隔符也不一致，比较永远是 `false`。守卫恒假，`boot()` 从未被调用。

**怎么修**：改用 Node 内置的 `pathToFileURL`，两边都走同一套标准化逻辑：

```js
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) { /* 启动 */ }
```

**怎么防**：只测「引入这个模块」拦不住这类接线错误——`import` 不会触发自启守卫里的分支。
必须再加一个**真 spawn 子进程**的测试：`spawn(process.execPath, ['src/index.mjs'], ...)`，
等它自己监听端口、真的响应 `/healthz`，再发 `SIGTERM` 确认能干净退出。见 `test/boot.test.mjs`
里的「spawn 真进程」用例。

## 2. Dockerfile 里的 apt 层多余且脆

**现象**：`docker build` 在 `apt-get install` 那一层报 "no installation candidate" 或类似的
源不可用错误，构建在第一次就失败，而且失败原因跟应用代码毫无关系。

**根因**：习惯性地给基础镜像加 `ca-certificates`、`tzdata` 这类包，但没有验证是不是真的需要。
实测 `node:24-bookworm-slim`：`/usr/share/zoneinfo/` 下的时区数据**已经内置**，`TZ` 环境变量
直接生效；Node 运行时**自带一份根证书**，容器内直连 HTTPS 服务（比如飞书开放平台）握手成功，
不依赖系统的 `ca-certificates`。

**怎么修**：整层 `apt-get` 删掉，只保留 `npm ci`。

**怎么防**：加任何 apt 层之前，先在目标基础镜像里手工验证到底缺不缺——`docker run --rm
<image> ls /usr/share/zoneinfo/<你的时区>`、`docker run --rm <image> node -e
"require('https').get('https://<你要连的域名>', r=>console.log(r.statusCode))"`。
镜像体积和构建可靠性都比「以防万一」更值钱。

## 3. PowerShell 函数参数取名 `$Args` 会被自动变量吃掉

**现象**：一个自定义 PowerShell 函数写了 `param([string[]]$Args)`，调用时无论传什么，函数体内
拿到的都是空——远程命令永远以「无参数」的方式被调用，等价于只打印一屏用法就退出，
上传/执行静默不发生，连报错都没有，非常难排查。

**根因**：`$Args`（连同 `$Args`、`$Input`、`$PSItem` 等）是 PowerShell 的**自动变量**，
函数体内引用 `$Args` 时，语言优先级让自动变量盖过同名的形参绑定，看起来像是参数没传进来。

**怎么修**：形参换一个不撞自动变量的名字，比如 `$CliArgs`：

```powershell
function Invoke-Something {
  param([string[]]$CliArgs)
  & $exe @CliArgs
}
```

**怎么防**：自定义函数的形参名，凡是通用词（`Args`、`Input`、`Host`、`Error` 等）一律加前缀
或换成更具体的名字；写完之后至少跑一次「传一个能观察到副作用的参数」的手工验证，
不要只看「命令没报错」就当成功——这类问题的特征就是安静地什么都不做。

## 4. `.ps1` 无 BOM 时 Windows PowerShell 5.1 按 ANSI 解，中文注释碎成语法错误

**现象**：脚本在 PowerShell 7（pwsh）里跑得好好的，换到 Windows 自带的 Windows PowerShell 5.1
（`powershell.exe`）执行同一个文件，直接报 `UnexpectedToken`、`TerminatorExpectedAtEndOfString`
这类看起来毫不相关的语法错误，报错位置往往落在某行中文注释附近。

**根因**：`.ps1` 文件保存成不带 BOM 的 UTF-8 时，Windows PowerShell 5.1 的默认解析编码会退回
系统 ANSI 代码页（中文 Windows 上通常是 GBK/CP936），把 UTF-8 的多字节序列拆成一堆不认识的
字节，中文字符（尤其是注释里的中文标点）被切碎成非法 token。PowerShell 7 因为默认按 UTF-8
解析，同一个文件反而没事，这进一步掩盖了问题——「在我这台机器上明明是好的」。

**怎么修**：把 `.ps1` 文件另存为「带 BOM 的 UTF-8」。命令行验证前 3 个字节：

```bash
head -c 3 script.ps1 | xxd   # 期望输出 efbb bf
```

**怎么防**：在 `.gitattributes` 里给 `*.ps1` 打 `-text`，防止 git 在 checkout/commit 时对着
BOM 或行尾做"聪明"的转换；本仓库脚本改完都跑一遍上面那条 `xxd` 检查再提交。

## 5. 附件摘要用 `readFile` 整份进内存，容器内存受限时会被 OOM

**现象**：本地开发时用小文件测试一切正常，但线上容器配了较低的内存上限（比如 256MB）后，
用户发一个几十上百 MB 的附件，容器直接被 OOM killed，进程重启，那条消息的转发也跟着丢失。

**根因**：算文件哈希（比如做去重或校验）时最直觉的写法是 `readFile` 把整个文件读进一个
`Buffer` 再喂给 `createHash`。这个 `Buffer` 的大小和文件大小成正比，与容器内存上限无关——
一个 100MB 的附件在 256MB 内存限制下，加上运行时本身的开销，很容易触顶。

**怎么修**：改成流式处理，内存占用只取决于内部缓冲区大小，不随文件大小增长：

```js
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const hash = createHash('sha256');
await pipeline(createReadStream(absPath), hash);
const digest = hash.digest('hex');
```

**怎么防**：任何"读一个大小不由自己控制的文件"的代码，默认假设它可能很大，优先考虑流式
API；如果一定要设上限，在流式管道里提前检查/截断，而不是先整份读进内存再判断超没超限。
容器的 `mem_limit` 要设得比开发机内存小得多，才能在本地就复现这类问题。

## 6. open_id 是按应用隔离的，从别的应用抄来的值必然对不上

**现象**：配置里填了「主人」的 `open_id`（从另一个应用的 CLI 或接口里抄来的），
授权时被自己的身份校验拒掉，提示「授权账号与配置里的主人不是同一个人」——
可你明明就是用本人账号点的同意。

**根因**：飞书的 `open_id` **不是全局用户 ID，而是「用户 × 应用」的组合 ID**。
同一个人在每个自建应用下都有一个不同的 `open_id`。
所以任何从别的应用、别的 CLI profile 里取到的 `open_id`，放到新应用里一律对不上。
（`chat_id` 不一样，它在同一租户内跨应用通用，这个差异很容易让人误以为 `open_id` 也通用。）

**怎么修**：拿到这个人在**本应用下**的 `open_id`。最省事的办法是让他给机器人发一条消息，
`im.message.receive_v1` 事件里的 `sender_id` 就是本应用下的值；
或者先完成一次授权，从 `authen/v1/user_info` 的返回里取。

**怎么防**：
- 身份校验失败时**把实际看到的 open_id 报出来**（这条路径本来就要管理员令牌，不是公开接口）。
  只说「对不上」不说「对不上什么」，这个错根本没法自查。
- 文档里凡是出现 `open_id` 的地方都标明它是按应用隔离的。
- 换应用、加应用时，所有存过的 `feishu_open_id` 映射都要重新建立，不能迁移。

## 7. Windows 写出来的 JSON 带 BOM，JSON.parse 直接抛错

**现象**：服务启动失败，报「读不了密钥」，但把文件打开看完全正常，
`cat` 出来也正常，JSON 语法挑不出毛病。

**根因**：Windows 上 PowerShell 的 `Set-Content -Encoding utf8` 会写入 UTF-8 BOM
（那三个字节 `EF BB BF` 在编辑器里不可见），而 `JSON.parse` 见到 BOM 会抛
`Unexpected token '﻿'`。配置和密钥文件经常是人手在 Windows 上生成的，所以很容易撞上。

**怎么修**：读文件后 `.replace(/^﻿/, '')` 再 parse。

**怎么防**：**每一处**读 JSON 的地方都要剥（我们就漏了命令行工具那一处，服务修好了、
CLI 还在原地报同样的错）。写个共用的读取函数，别各写各的。
