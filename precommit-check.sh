#!/usr/bin/env bash
# Stage everything, print exactly what would be committed, then commit.
set -e
cd /mnt/c/Users/PC/.trae-cn/tools

git init -q 2>/dev/null || true
git config user.name "byokrouter"
git config user.email "noreply@example.com"
git config core.autocrlf false

git add -A

echo "=============================================================="
echo " files staged for the first commit"
echo "=============================================================="
git diff --cached --name-only

echo
echo "=============================================================="
echo " sanity: are any secrets staged?"
echo "=============================================================="
if git diff --cached --name-only | grep -Ei '(^|/)(\.env$|keys\.json$|.*\.token$|\.state/)' ; then
  echo "!! ABORT: secret-shaped paths are staged"
  exit 1
fi
echo "none"

echo
echo "=============================================================="
echo " secret scan over the STAGED set"
echo "=============================================================="
node scan-secrets.mjs --staged || { echo "!! ABORT: scan-secrets found issues"; exit 1; }
