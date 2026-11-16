#!/usr/bin/env bash
set -euo pipefail
root="$HOME/gex-cloud"
export PATH="$root/runtime/node/bin:$PATH"
exec 9>"$root/deploy.lock"
flock -n 9 || exit 0
if [ ! -d "$root/repo/.git" ]; then git clone --depth=1 https://github.com/gongxy810/moomoo-gex.git "$root/repo"; fi
git -C "$root/repo" fetch --depth=1 origin refs/tags/gex-v3-tested
commit=$(git -C "$root/repo" rev-parse FETCH_HEAD)
if [ -f "$root/deployed-sha" ] && [ "$(cat "$root/deployed-sha")" = "$commit" ]; then exit 0; fi
release="$root/releases/$commit"
mkdir -p "$release"
git -C "$root/repo" archive "$commit" 'Gex heatmap v3' | tar -xf - --strip-components=1 -C "$release"
# Independent verification on the target, before changing the running release.
cd "$release"
node --test tests/model.test.mjs tests/replay.test.mjs tests/structure.test.mjs
"$HOME/moomoo-gex/venv/bin/python" -m unittest discover -s tests -p 'test_*.py'
previous=$(readlink "$root/current" || true)
ln -sfn "$release" "$root/next"
mv -Tf "$root/next" "$root/current"
sudo -n systemctl restart gex-board.service
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8766/api/health | "$HOME/moomoo-gex/venv/bin/python" -c 'import json,sys; h=json.load(sys.stdin); assert h["relay"] and h["currentOnDisk"]'; then
    printf '%s\n' "$commit" > "$root/deployed-sha"
    exit 0
  fi
  sleep 1
done
if [ -n "$previous" ]; then
  ln -sfn "$previous" "$root/rollback"
  mv -Tf "$root/rollback" "$root/current"
  sudo -n systemctl restart gex-board.service
fi
exit 1
