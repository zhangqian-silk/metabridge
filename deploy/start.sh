#!/usr/bin/env bash
# 加载用户的 nvm 环境后再启动服务，使服务内的 node/codex
# 与用户终端中运行的一致（nvm default alias 指向的版本）。
# nvm 升级或切换 default 版本后，重启服务即可跟随，无需改 service 文件。
# nvm 未安装时静默回退系统 node。
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
# Node's environment proxy does not reliably interpret CIDR entries in NO_PROXY.
# Preserve the user's bypasses and add explicit loopback destinations for CPA.
export NO_PROXY="127.0.0.1,localhost,::1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="127.0.0.1,localhost,::1${no_proxy:+,$no_proxy}"
export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"
exec node "$@"
