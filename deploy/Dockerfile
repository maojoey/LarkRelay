# 只用于资源有限（2 核/1.6G 级别）的单容器部署，见 docs/OPERATIONS.md。
# registry 可用 --build-arg NPM_REGISTRY=... 覆盖（如果配了镜像加速器，默认走 npmmirror）
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM node:24-bookworm-slim

# 刻意不装任何 apt 包。在目标服务器上实测过这两件事：
#   · tzdata **已经在 node:24-bookworm-slim 里**（/usr/share/zoneinfo/Asia/Shanghai 存在，
#     TZ 生效），「slim 镜像不带时区库」这条常见教训对 Node 官方镜像不成立；
#   · ca-certificates 没装，但 **Node 用自带根证书**，实测容器内直连 open.feishu.cn 握手成功。
# 加 apt 层只会让构建依赖 Debian 源的可用性——第一次构建就是栽在这上面（no installation candidate）。
WORKDIR /app
ARG NPM_REGISTRY
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry="${NPM_REGISTRY}"

COPY src ./src
COPY bin ./bin

# node:24-bookworm-slim 自带 uid 1000 的 node 用户，和 /data/larkrelay 属主对齐
USER node

CMD ["node", "src/index.mjs"]
