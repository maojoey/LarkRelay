#!/bin/sh
# 回滚到已经部署过的某个 release（其目录必须还在 /opt/larkrelay/releases/<sha> 下，
# 对应镜像 larkrelay:<sha> 也必须还在本地——remote-deploy.sh 只保留最近 5 个）。
# 不重新 build，只切符号链接再 up -d。最后一行固定打印 ROLLBACK_EXIT=<0|1>。
set -e

SHA="$1"
if [ -z "$SHA" ]; then
  echo "用法：remote-rollback.sh <sha>" >&2
  echo "ROLLBACK_EXIT=1"
  exit 0
fi

BASE=/opt/larkrelay
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
TARGET="$RELEASES/$SHA"
COMPOSE_FILE="deploy/docker-compose.yml"
CONTAINER=larkrelay
MAX_WAIT=120
INTERVAL=5

if [ ! -d "$TARGET" ]; then
  echo "找不到 release 目录：$TARGET（ls $RELEASES 看还有哪些）" >&2
  echo "ROLLBACK_EXIT=1"
  exit 0
fi

if ! docker image inspect "larkrelay:$SHA" >/dev/null 2>&1; then
  echo "找不到镜像 larkrelay:$SHA，需要先 remote-deploy.sh $SHA 重新 build" >&2
  echo "ROLLBACK_EXIT=1"
  exit 0
fi

ln -sfn "$TARGET" "$BASE/current.tmp"
mv -T "$BASE/current.tmp" "$CURRENT"
echo "current -> releases/$SHA"

cd "$CURRENT"
export RELAY_VERSION="$SHA"
docker compose -f "$COMPOSE_FILE" up -d

status=unknown
waited=0
while [ "$waited" -lt "$MAX_WAIT" ]; do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  [ "$status" = "healthy" ] && break
  sleep "$INTERVAL"
  waited=$((waited + INTERVAL))
done

if [ "$status" = "healthy" ]; then
  echo "回滚后健康检查通过"
  echo "ROLLBACK_EXIT=0"
else
  echo "回滚后健康检查未通过（状态：$status）" >&2
  echo "ROLLBACK_EXIT=1"
fi
