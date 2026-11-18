#!/usr/bin/env bash
set -euo pipefail
root="$HOME/gex-cloud"
export PATH="$root/runtime/node/bin:$PATH"
exec 9>"$root/deploy.lock"
flock -n 9 || exit 0
if [ ! -d "$root/repo/.git" ]; then git clone --depth=1 https://github.com/gongxy810/moomoo-gex.git "$root/repo"; fi
git -C "$root/repo" fetch --no-tags --depth=1 origin refs/tags/gex-v3-tested
commit=$(git -C "$root/repo" rev-parse FETCH_HEAD)
if [ -f "$root/deployed-sha" ] && [ "$(cat "$root/deployed-sha")" = "$commit" ]; then exit 0; fi
release="$root/releases/$commit"
mkdir -p "$release"
git -C "$root/repo" archive "$commit" 'Gex heatmap v3' | tar -xf - --strip-components=1 -C "$release"
# GitHub Actions runs the full suites before moving gex-v3-tested. Target-side tests below are a lightweight deployment smoke check.
cd "$release"
environment="$root/envs/$(sha256sum requirements.txt | cut -d' ' -f1)"
if [ ! -f "$environment/ready" ]; then
  python3 -m venv "$environment"
  "$environment/bin/python" -m pip install -r requirements.txt
  touch "$environment/ready"
fi
node --test tests/model.test.mjs tests/replay.test.mjs tests/structure.test.mjs
previous=$(readlink "$root/current" || true)
previous_python=$(readlink "$root/python" || true)
ln -sfn "$environment" "$root/next-python"
mv -Tf "$root/next-python" "$root/python"
ln -sfn "$release" "$root/next"
mv -Tf "$root/next" "$root/current"
sudo -n cp "$release/cloud/gex-board.service" /etc/systemd/system/gex-board.service
sudo -n systemctl daemon-reload
sudo -n systemctl restart gex-board.service || true
for attempt in $(seq 1 30); do
  if curl -fsS --connect-timeout 2 --max-time 4 http://127.0.0.1:8766/api/health 2>/dev/null | "$environment/bin/python" -c 'import json,sys; h=json.load(sys.stdin); assert h["relay"] and h["currentOnDisk"] and h["webRoot"]==sys.argv[1]' "$release/web" 2>/dev/null; then
    printf '%s\n' "$commit" > "$root/deployed-sha"
    install -m 755 "$release/cloud/pull-release.sh" "$root/pull-release.next"
    mv -Tf "$root/pull-release.next" "$root/pull-release.sh"
    exit 0
  fi
  sleep 1
done
if [ -n "$previous" ]; then
  ln -sfn "$previous" "$root/rollback"
  mv -Tf "$root/rollback" "$root/current"
  if [ -n "$previous_python" ]; then ln -sfn "$previous_python" "$root/python"; fi
  sudo -n cp "$previous/cloud/gex-board.service" /etc/systemd/system/gex-board.service
  sudo -n systemctl daemon-reload
  sudo -n systemctl restart gex-board.service
fi
exit 1
