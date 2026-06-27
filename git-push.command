#!/bin/bash
# ─── PUSH TO GITHUB → triggers Railway redeploy ───────────────────────────────
# Double-click this in Finder whenever you want to deploy changes.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")"

echo "🧹 Cleaning up any stalled git operation..."
git rebase --abort  2>/dev/null || true
git merge  --abort  2>/dev/null || true
git cherry-pick --abort 2>/dev/null || true

echo ""
echo "📋 Staging all changes..."
git add -A

echo ""
echo "📝 Files being committed:"
git diff --cached --name-only

echo ""
echo "💬 Committing..."
git commit -m "feat: Telegram bot + Supabase + carbon impact ($(date '+%Y-%m-%d'))" --allow-empty

echo ""
echo "🚀 Pushing to GitHub..."
git push --force-with-lease origin HEAD:main

echo ""
echo "✅ Done! Railway will redeploy in ~2 minutes."
echo ""
echo "─────────────────────────────────────────────"
echo "⚠️  NEXT STEPS — add these to Railway env vars:"
echo "─────────────────────────────────────────────"
echo "  SUPABASE_URL             → supabase.com → project settings → API"
echo "  SUPABASE_SERVICE_KEY     → service_role key (not anon key)"
echo "  SUPABASE_STORAGE_BUCKET  → session-images"
echo "  TELEGRAM_USE_WEBHOOK     → true"
echo "  TELEGRAM_WEBHOOK_SECRET  → any random string"
echo ""
echo "  Then register the webhook (paste in browser, fill in your values):"
echo "  https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<RAILWAY_URL>/api/telegram/webhook&secret_token=<WEBHOOK_SECRET>"
echo ""
echo "  And run backend/db/schema.sql in Supabase → SQL Editor."
echo "─────────────────────────────────────────────"
echo ""
read -n 1 -p "Press any key to close."
