# 🌱 Sustainability Ministry Portal

A one-stop internal dashboard for the Sustainability Ministry, covering:
- **⚡ Energy** — Electricity & water consumption tracking
- **♻️ W2R** — Cardboard & plastic bottle recycling stats  
- **📢 Comms** — Post scheduling calendar
- **📋 Roster & Swaps** — W2R weekend roster + Telegram-connected swap requests

---

## 📁 Project Structure

```
susty-portal/
├── frontend/
│   └── index.html          # Single-page app (all 5 pages)
├── backend/
│   ├── server.js           # Express entry point
│   ├── routes/
│   │   ├── recycling.js
│   │   ├── energy.js
│   │   ├── roster.js
│   │   ├── comms.js
│   │   └── swap.js         # Swap logic + Telegram notify
│   └── data/
│       ├── recycling.js    # W2R data (seeded from Google Drive)
│       ├── energy.js       # Energy data (awaiting input)
│       └── swap-requests.json
├── .env.example
└── package.json
```

---

## 🚀 Local Setup

```bash
# 1. Clone and install
git clone https://github.com/YOUR_ORG/susty-portal.git
cd susty-portal
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Telegram bot token and group chat ID

# 3. Run
npm start            # production
npm run dev          # with auto-reload (nodemon)
```

Open `http://localhost:3001`

---

## 🌐 GitHub Hosting

### Frontend — GitHub Pages (free, static)

1. Push to `main` — GitHub Actions auto-deploys `frontend/` to `gh-pages` branch
2. In repo Settings → Pages → Source: `gh-pages` branch
3. Your site: `https://YOUR_ORG.github.io/susty-portal/`

> ⚠️ **GitHub Pages is static only.** Swap requests and live data need the backend running separately.

### Backend — Recommended free hosts

| Platform | Notes |
|----------|-------|
| **Railway** | `railway up` — easiest, free tier |
| **Render** | Connect repo, set env vars, auto-deploy |
| **Fly.io** | Good for Singapore region latency |

After deploying the backend, update the `API` constant in `frontend/index.html`:
```javascript
const API = 'https://your-backend.railway.app/api';
```

---

## 🔧 Updating Data

### Adding energy data
Edit `backend/data/energy.js` and fill in the `kwh` / `m3` values.

### Adding recycling data
Edit `backend/data/recycling.js` — arrays are chronological.

### Adding comms calendar entries
Edit `backend/routes/comms.js` → the `calendar` array.

### Roster
Edit `backend/routes/roster.js` → `w2rRoster` array.

---

## 🤖 Telegram Swap Bot Setup

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → get your token
2. Add the bot to your ministry Telegram group
3. Message [@userinfobot](https://t.me/userinfobot) in the group to get the group's `chat_id`
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`

When a member submits a swap request, the bot sends:
> 🔄 *Roster Swap Request*  
> 👤 **Clara Cheong** wants to swap their **28 Jun (Sat)** slot.  
> 📝 Reason: Overseas trip  
> Reply in the portal to volunteer!

When matched:
> ✅ *Swap Matched!*  
> Clara Cheong (28 Jun) ↔️ Brendon (5 Jul)

---

## 📌 Roadmap / Next Steps

- [ ] Add energy data from Energy Team
- [ ] Hook up to Google Sheets API for live recycling sync
- [ ] Add authentication (simple password or Google OAuth)
- [ ] Mobile push notifications for swap alerts
