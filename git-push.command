#!/bin/bash
# ─── PUSH TO GITHUB → triggers Railway redeploy ───────────────────────────────
# Double-click this in Finder whenever you want to deploy changes.
# Safe to run multiple times. Never resets or wipes your files.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")"

echo "🧹 Cleaning up any stalled git operation..."
git rebase --abort  2>/dev/null || true
git merge  --abort  2>/dev/null || true
git cherry-pick --abort 2>/dev/null || true

echo "📋 Staging all changes..."
git add -A

echo "💬 Committing..."
git commit -m "deploy: update $(date '+%Y-%m-%d %H:%M')" --allow-empty

echo "🚀 Pushing to GitHub (force-with-lease = safe force push)..."
git push --force-with-lease origin HEAD:main

echo ""
echo "✅ Done! Railway will redeploy in ~2 minutes."
echo "   Check: https://railway.app → your project → Deployments"
echo ""
read -n 1 -p "Press any key to close."
