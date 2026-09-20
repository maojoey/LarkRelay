#!/bin/sh
# 首次装机（也可重复跑）：建目录、定权限、查 docker。只在服务器上跑，
# 通过部署脚本上传后执行，不要手工改。
set -e

RELEASES=/opt/larkrelay/releases
DATA=/data/larkrelay

mkdir -p "$RELEASES"
mkdir -p "$DATA/config" "$DATA/db" "$DATA/files" "$DATA/outgoing"

chown -R 1000:1000 "$DATA"
chmod 700 "$DATA/config"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker：不可用" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "docker：命令存在但 daemon 不可用（权限或未启动？）" >&2
  exit 1
fi

echo "releases 目录：$RELEASES"
echo "data 目录：$(find "$DATA" -maxdepth 1 -mindepth 1 | wc -l) 个子目录"
echo "$DATA 权限：$(stat -c '%U:%G %a' "$DATA")"
echo "$DATA/config 权限：$(stat -c '%U:%G %a' "$DATA/config")"
echo "docker：可用（$(docker --version)）"
