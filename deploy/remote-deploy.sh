#!/bin/sh
# 部署一个 release：解包 -> 原子切 current -> build -> up -d -> 等健康 -> 失败自动回滚。
# 首次 docker build 可能超过某些远程执行工具的超时限制，本脚本设计为由 deploy.ps1
# 用 `nohup sh remote-deploy.sh <sha> > /tmp/deploy.log 2>&1 &` 后台起、轮询日志。
# 最后一行固定打印 DEPLOY_EXIT=<0|1>，本机靠这行判断是否结束。
set -e

SHA="$1"
if [ -z "$SHA" ]; then
  echo "用法：remote-deploy.sh <sha>" >&2
  echo "DEPLOY_EXIT=1"
  exit 0
fi

BASE=/opt/larkrelay
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
TARBALL="/tmp/larkrelay-$SHA.tgz"
COMPOSE_FILE="deploy/docker-compose.yml"
CONTAINER=larkrelay
MAX_WAIT=120
INTERVAL=5
KEEP=5

switch_current() {
  # ln -sfn 建临时链接 + mv -T 覆盖，两步都是原子操作，不会有「current 指向空」的中间态
  ln -sfn "$1" "$BASE/current.tmp"
  mv -T "$BASE/current.tmp" "$CURRENT"
}

wait_healthy() {
  waited=0
  while [ "$waited" -lt "$MAX_WAIT" ]; do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
    if [ "$status" = "healthy" ]; then
      return 0
    fi
    sleep "$INTERVAL"
    waited=$((waited + INTERVAL))
  done
  return 1
}

# 只留最近 KEEP 个 release 目录与镜像标签，防止 28G 根盘被历史版本吃满
prune_old_releases() {
  ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    old_sha=$(basename "$old")
    [ "$old_sha" = "$SHA" ] && continue
    rm -rf "$old"
    docker rmi "larkrelay:$old_sha" >/dev/null 2>&1 || true
    echo "已清理旧 release：$old_sha"
  done
}

if [ ! -f "$TARBALL" ]; then
  echo "找不到 $TARBALL，先把打包产物上传上来" >&2
  echo "DEPLOY_EXIT=1"
  exit 0
fi

mkdir -p "$RELEASES"
PREV=""
if [ -L "$CURRENT" ]; then
  PREV=$(readlink "$CURRENT")
fi

RELEASE_DIR="$RELEASES/$SHA"
mkdir -p "$RELEASE_DIR"
tar xzf "$TARBALL" -C "$RELEASE_DIR"
echo "已解包：$RELEASE_DIR"

switch_current "$RELEASE_DIR"
echo "current -> releases/$SHA"

cd "$CURRENT"
export RELAY_VERSION="$SHA"

build_ok=1
if docker compose -f "$COMPOSE_FILE" build && docker compose -f "$COMPOSE_FILE" up -d; then
  build_ok=0
fi

if [ "$build_ok" -eq 0 ] && wait_healthy; then
  echo "健康检查通过（$CONTAINER healthy）"
  prune_old_releases
  echo "DEPLOY_EXIT=0"
  exit 0
fi

echo "部署未通过（build_ok=$build_ok），回滚" >&2
if [ -n "$PREV" ] && [ -d "$PREV" ]; then
  switch_current "$PREV"
  cd "$CURRENT"
  export RELAY_VERSION=$(basename "$PREV")
  docker compose -f "$COMPOSE_FILE" up -d || true
  if wait_healthy; then
    echo "已回滚到 $(basename "$PREV")，健康检查通过" >&2
  else
    echo "已回滚到 $(basename "$PREV")，但健康检查仍未通过——需要人工介入" >&2
  fi
else
  echo "没有可回滚的上一个 release" >&2
fi

echo "DEPLOY_EXIT=1"
exit 0
