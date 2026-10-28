#!/usr/bin/env bash
# Push ../_site to the gh-pages branch of origin (GitHub Pages serves that branch).
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE=$(git remote get-url origin)
cd _site
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Publish site $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q -f "$REMOTE" gh-pages
rm -rf .git
echo "published to gh-pages"
