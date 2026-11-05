#!/usr/bin/env bash
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

STAGING=/vercel/sandbox/emdash-launcher
source "$STAGING/runtime-env.sh"
install -d -m 0755 /run/sshd
/usr/sbin/sshd -t -f "$STAGING/sshd_config"
if ! python3 -c "import socket; socket.create_connection(('127.0.0.1',2222),1).close()" 2>/dev/null; then
  /usr/sbin/sshd -f "$STAGING/sshd_config"
fi
for _ in $(seq 1 50); do
  if python3 -c "import socket; socket.create_connection(('127.0.0.1',2222),1).close()" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
python3 -c "import socket; socket.create_connection(('127.0.0.1',2222),1).close()"

if ! runuser -u emdash -- env PATH="$EMDASH_USER_PATH" /home/emdash/.emdash/workspace-server/current/bin/emdash-workspace-server status; then
  runuser -u emdash -- env PATH="$EMDASH_USER_PATH" /home/emdash/.emdash/workspace-server/current/bin/emdash-workspace-server start
fi
echo RUNTIME_READY
