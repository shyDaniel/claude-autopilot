#!/usr/bin/env bash
# One-shot helper to create a GitHub repo for this project and push main.
# Requires: gh CLI (https://cli.github.com) authenticated with `gh auth login`.
set -euo pipefail

REPO_NAME="${1:-claude-autopilot}"
VISIBILITY="${2:-public}"   # public | private

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI is not installed. Install it:"
  echo "  - Debian/Ubuntu: https://cli.github.com/manual/installation"
  echo "  - macOS:         brew install gh"
  echo "Then run: gh auth login"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated. Run: gh auth login"
  exit 1
fi

cd "$(dirname "$0")/.."

if git remote get-url origin >/dev/null 2>&1; then
  echo "origin already set to: $(git remote get-url origin)"
  git push -u origin main
  exit 0
fi

echo "Creating GitHub repo '${REPO_NAME}' (${VISIBILITY})..."
gh repo create "${REPO_NAME}" --"${VISIBILITY}" --source=. --remote=origin --push
echo "Done. Remote: $(git remote get-url origin)"
