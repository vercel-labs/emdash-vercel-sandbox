#!/usr/bin/env bash
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKSPACE_SERVER_VERSION=0.1.13
STAGING=/vercel/sandbox/emdash-launcher

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq openssh-server git tmux curl ca-certificates

if ! id emdash >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash emdash
  usermod --password '*' emdash
fi

install -d -m 0755 -o emdash -g emdash \
  /home/emdash/.cache /home/emdash/.config /home/emdash/.emdash \
  /home/emdash/.local /home/emdash/.local/bin /home/emdash/.local/share \
  /home/emdash/.local/state /home/emdash/project
chown root:root "$STAGING" "$STAGING"/*.sh "$STAGING/remote-bridge.mjs" "$STAGING"/*.py
chmod 0755 "$STAGING"
chmod 0644 "$STAGING"/*.sh "$STAGING/remote-bridge.mjs" "$STAGING"/*.py
source "$STAGING/runtime-env.sh"
printf '\nexport PATH="%s"\n' "$EMDASH_USER_PATH" >> /home/emdash/.profile
chown emdash:emdash /home/emdash/.profile

install -d -m 0700 -o emdash -g emdash /home/emdash/.ssh
install -m 0600 -o emdash -g emdash "$STAGING/client.pub" /home/emdash/.ssh/authorized_keys
install -d -m 0755 /run/sshd
ssh-keygen -A
cat > "$STAGING/sshd_config" <<'CONFIG'
Port 2222
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile /run/emdash-sandbox-launcher-sshd.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
PermitRootLogin no
AllowUsers emdash
AllowTcpForwarding local
PermitOpen 127.0.0.1:2222 [/home/emdash/.emdash/workspace-server/run/workspace.sock]:*
AllowStreamLocalForwarding yes
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp internal-sftp
CONFIG
printf 'SetEnv PATH=%s\n' "$EMDASH_USER_PATH" >> "$STAGING/sshd_config"
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

branch=main
if test -f "$STAGING/repository.bundle"; then
  test "$#" -eq 3
  branch="$1"
  chmod 0644 "$STAGING/repository.bundle"
  runuser -u emdash -- python3 "$STAGING/bootstrap-project.py" /home/emdash/project "$STAGING/repository.bundle" "$branch" "$2" "$3"
else
  test "$#" -eq 0
  runuser -u emdash -- python3 "$STAGING/bootstrap-project.py" /home/emdash/project
fi
runuser -u emdash -- git -C /home/emdash/project config user.name "Emdash Sandbox"
runuser -u emdash -- git -C /home/emdash/project config user.email "emdash-sandbox@example.invalid"
if ! test -d /home/emdash/origin.git; then
  runuser -u emdash -- git init --bare /home/emdash/origin.git
fi
if runuser -u emdash -- git -C /home/emdash/project remote get-url origin >/dev/null 2>&1; then
  runuser -u emdash -- git -C /home/emdash/project remote set-url origin /home/emdash/origin.git
else
  runuser -u emdash -- git -C /home/emdash/project remote add origin /home/emdash/origin.git
fi
runuser -u emdash -- git -C /home/emdash/project push -u origin "$branch"
runuser -u emdash -- git --git-dir=/home/emdash/origin.git symbolic-ref HEAD "refs/heads/$branch"

installer="$STAGING/workspace-server-install.sh"
curl -fsSL "https://releases.emdash.sh/workspace-server/$WORKSPACE_SERVER_VERSION/install.sh" -o "$installer"
printf '%s  %s\n' '3b4d8af4ceb468465d0337cdf2e86932cec3ff0dc637608eff4740e9bf0e77b8' "$installer" | sha256sum -c -
case "$(uname -m)" in
  x86_64|amd64) server_sha256=10ae29ebce6eb1fa1627d9723bbd3fd7c03755c663f73047452ff4e52f0f9883 ;;
  aarch64|arm64) server_sha256=0c86d4488ecb46fe42f9808265b7ac06ebd0247bef6193798d6c0db60666f35a ;;
  *) echo 'Unsupported workspace-server architecture' >&2; exit 1 ;;
esac
runuser -u emdash -- sh "$installer" --base-url https://releases.emdash.sh/workspace-server --version "$WORKSPACE_SERVER_VERSION" --sha256 "$server_sha256"
npm install --prefix "$STAGING" --ignore-scripts --no-audit --no-fund ws@8.18.3

echo BOOTSTRAP_READY
