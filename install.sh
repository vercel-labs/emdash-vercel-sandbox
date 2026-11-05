#!/bin/sh
set -eu
umask 077

release=v0.1.0-preview.1
asset=emdash-sandbox-darwin-arm64.tar.gz
base="https://github.com/vercel-labs/emdash-vercel-sandbox/releases/download/$release"

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This preview supports Apple Silicon Macs. Other platforms are not packaged yet.' >&2
  exit 1
fi
for tool in curl tar shasum awk mktemp; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Setup needs $tool." >&2; exit 1; }
done

download_dir=$(mktemp -d "${TMPDIR:-/tmp}/emdash-sandbox.XXXXXXXX")
download_dir=$(cd "$download_dir" && pwd -P)
trap 'rm -rf "$download_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --connect-timeout 15 --max-time 300 "$1" -o "$2"
}
echo 'Installing Vercel setup for EmDash…' >&2
fetch "$base/SHA256SUMS" "$download_dir/SHA256SUMS"
expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$download_dir/SHA256SUMS")
case "$expected" in ''|*[!0-9a-f]*) echo 'Invalid release checksum.' >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { echo 'Invalid release checksum.' >&2; exit 1; }
fetch "$base/$asset" "$download_dir/$asset"
actual=$(shasum -a 256 "$download_dir/$asset" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo 'Download checksum mismatch. Nothing was installed.' >&2; exit 1; }
tar -tzf "$download_dir/$asset" > "$download_dir/files"
awk 'index($0,"emdash-sandbox/") != 1 || $0 ~ /(^|\/)\.\.(\/|$)/ {bad=1} END {exit bad}' "$download_dir/files" || {
  echo 'Invalid release archive paths.' >&2; exit 1;
}
tar -tvzf "$download_dir/$asset" > "$download_dir/types"
awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" {bad=1} END {exit bad}' "$download_dir/types" || {
  echo 'Release archive contains unsupported links.' >&2; exit 1;
}
tar -xzf "$download_dir/$asset" -C "$download_dir"
"$download_dir/emdash-sandbox/payload/node" "$download_dir/emdash-sandbox/cli-install.mjs" "$@"
