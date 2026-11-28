#!/usr/bin/env bash
# Playwright's browsers for a CI job (its arguments: chromium, or chromium firefox webkit), and on
# Linux the packages they need from apt; said in time, whatever happens.
#
#   scripts/ci-browsers.sh chromium
#
# On Linux apt keeps what it downloads in ~/apt-archives, which CI keeps between runs: a job whose
# packages are kept downloads none, and a mirror that trickles (Azure's has taken ten minutes for
# 25 MB) costs nothing. apt drops a mirror that sends nothing for 30 s and tries again, three
# times. A try that still takes too long is ended and the install tried once more, keeping what
# came; then it's said, and the job fails (in 11 minutes: CI's step allows 12).
set -uo pipefail

if [ "${RUNNER_OS:-}" != Linux ]; then
  exec npx playwright install "$@"
fi
kept="$HOME/apt-archives"
mkdir -p "$kept/partial"
printf 'Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::Retries "3";\nDir::Cache::Archives "%s/";\n' "$kept" |
  sudo tee /etc/apt/apt.conf.d/80-ci > /dev/null
for limit in 420 240; do
  if timeout "$limit" npx playwright install --with-deps "$@"; then
    # What's kept: the packages that can still be had, the runner's own, for CI to save.
    sudo apt-get autoclean -qq || true
    sudo chown -R "$(id -u):$(id -g)" "$kept"
    rm -rf "$kept/partial" "$kept/lock"
    exit 0
  fi
  echo "::warning::Playwright's browsers weren't installed in $((limit / 60)) minutes: trying again, with what came kept."
  # (An apt ended half way leaves its lock, and dpkg perhaps half done: put right first.)
  sudo pkill -x apt-get || true
  sudo dpkg --configure -a || true
done
echo "::error::Playwright's browsers couldn't be installed in 11 minutes: apt (or Playwright's download) stalled or failed. Run the job again."
exit 1
