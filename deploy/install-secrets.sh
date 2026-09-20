#!/bin/sh
# 装/换 secrets.json。只打印 sha256 与权限位，绝不 cat 内容。
# 用法：把本地 secrets.json 上传成服务器上的 /tmp/secrets.json，再在服务器上执行本脚本
# （如 sh /tmp/install-secrets.sh）
set -e

SRC=/tmp/secrets.json
DEST=/data/larkrelay/config/secrets.json

if [ ! -f "$SRC" ]; then
  echo "找不到 $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
mv "$SRC" "$DEST"
chown 1000:1000 "$DEST"
chmod 600 "$DEST"

echo "sha256：$(sha256sum "$DEST" | cut -d' ' -f1)"
echo "权限：$(ls -l "$DEST")"
