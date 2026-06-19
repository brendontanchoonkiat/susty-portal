# 🚀 Deployment Guide — Susty Ministry Portal

Plain, step-by-step. No prior experience needed. Free, no credit card required.

---

## What you'll set up

| Part | Host | Cost |
|---|---|---|
| Frontend (the website) | GitHub Pages | Free |
| Backend (swap requests, Telegram) | Railway | Free |

Total time: ~20 minutes.

---

## STEP 1 — Create a free GitHub account

1. Go to https://github.com
2. Click **Sign up**
3. Enter your email, create a password, choose a username
4. Verify your email when prompted

---

## STEP 2 — Create a PUBLIC repository

1. Once logged in, click the **+** icon (top-right) → **New repository**
2. Fill in:
   - **Repository name:** `susty-portal`
   - **Visibility:** ✅ **Public** ← important, GitHub Pages is free only on public repos
   - Leave everything else unchecked
3. Click **Create repository**

> Your source code will be publicly viewable — this is safe because all secrets
> (Telegram token, API key) are stored in Railway, never in the code.

---

## STEP 3 — Upload the project files

1. On your new (empty) repo page, click **uploading an existing file**
2. Open your `susty-portal` folder on your computer
3. Select everything inside it and drag it into the GitHub upload area:
   ```
   frontend/
   backend/
   .github/
   package.json
   .gitignore
   README.md
   DEPLOY.md
   .env.example
   ```
   ⚠️ Do **NOT** upload a `.env` file if you have one — it contains secrets
4. Scroll down → write a commit message: `initial upload`
5. Click **Commit changes**

Wait a few seconds for the upload to finish. You should now see all your files listed in the repo.

---

## STEP 4 — Enable GitHub Pages (hosts the frontend)

1. In your repo, click **Settings** (top navigation bar)
2. In the left sidebar, click **Pages**
3. Under **Branch**, open the dropdown → select `main` → folder stays as `/ (root)` → click **Save**

> ⚠️ GitHub Pages serves from the root by default, but your HTML is inside
> `frontend/`. Do this one extra step to redirect correctly:

4. Go back to the **Code** tab of your repo
5. Click **Add file** → **Create new file**
6. Name it: `index.html`
7. Paste this as the entire file content:
   ```html
   <meta http-equiv="refresh" content="0; url=frontend/index.html">
   ```
8. Click **Commit changes**

Your site will be live at:
```
https://YOUR_USERNAME.github.io/susty-portal/
```
Replace `YOUR_USERNAME` with your actual GitHub username. Takes 1–3 minutes to go live — you'll see the confirmed URL appear in Settings → Pages.

---

## STEP 5 — Deploy the backend on Railway

The backend handles swap requests and Telegram notifications.

1. Go to https://railway.app
2. Click **Login** → **Login with GitHub** → authorise Railway
3. Click **New Project** → **Deploy from GitHub repo**
4. Select `susty-portal` from the list
5. Railway detects Node.js automatically → click **Deploy Now**
6. Wait ~2 minutes for the first deploy (you'll see a green "Success")

### Add your secret environment variables

7. Click on your service → click the **Variables** tab
8. Click **New Variable** and add each of these:

| Variable name | What to put |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your bot token (get this in Step 7) |
| `TELEGRAM_CHAT_ID` | Your group chat ID (get this in Step 7) |
| `ADMIN_API_KEY` | Any long password you make up — min 20 characters, e.g. `sustyMinistry2026secretKey!` |
| `ALLOWED_ORIGINS` | `https://YOUR_USERNAME.github.io` (your exact GitHub Pages URL) |
| `PORT` | `3001` |

9. Railway restarts automatically after you add variables

### Get your backend URL

10. Click **Settings** tab → scroll to **Networking** → click **Generate Domain**
11. Copy the URL — it looks like:
    ```
    susty-portal-production.up.railway.app
    ```

---

## STEP 6 — Connect frontend to backend

Tell your website where the backend lives.

1. In your GitHub repo, click into `frontend` → click `index.html`
2. Click the **pencil icon** (Edit file) in the top-right corner
3. Use **Ctrl+F** (Windows) or **Cmd+F** (Mac) to search for:
   ```
   const API = '/api';
   ```
4. Replace that line with:
   ```javascript
   const API = 'https://susty-portal-production.up.railway.app/api';
   ```
   Use your actual Railway URL from Step 5.
5. Scroll down → click **Commit changes** → **Commit changes** again to confirm

GitHub Pages updates within 1–2 minutes.

---

## STEP 7 — Set up the Telegram swap bot

1. Open Telegram → search **@BotFather** → tap **Start**
2. Type `/newbot` and follow the prompts:
   - Bot name: e.g. `Susty Ministry Bot`
   - Bot username: e.g. `sustyministry_bot` (must end in `bot`)
3. BotFather sends you a token like:
   ```
   123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
   ```
   → Paste this as `TELEGRAM_BOT_TOKEN` in Railway

4. Add the bot to your ministry Telegram group:
   - Open the group → group name at top → **Add Members** → search your bot username → add

5. Get the group's chat ID:
   - In the group, type `/start@userinfobot` — the bot replies with the chat ID
   - It's a negative number like `-1001234567890`
   - → Paste this as `TELEGRAM_CHAT_ID` in Railway

---

## ✅ You're live!

Visit `https://YOUR_USERNAME.github.io/susty-portal/`

Test by submitting a swap request on the Roster page — you should get a Telegram message in the ministry group within a few seconds.

---

## Weekly data updates (after launch)

The site does **not** auto-sync from Google Drive. Update data by editing files directly on GitHub — no terminal needed.

### How to edit any file on GitHub

1. Go to your repo → navigate to the file
2. Click the **pencil icon** → edit → **Commit changes**
3. Railway redeploys automatically in ~1 minute

### Which file to edit for each update

| What needs updating | File to edit | What to add |
|---|---|---|
| Cardboard recycling (kg) | `backend/data/recycling.js` | New line in `cardboardData` |
| Plastic bottles (kg) | `backend/data/recycling.js` | New line in `plasticData` |
| Electricity / water figures | `backend/data/energy.js` | Fill in `kwh` or `m3` value |
| New comms post | `backend/routes/comms.js` | New entry in `calendar` array |
| Roster change | `backend/routes/roster.js` | Update `w2rRoster` array |

**Example — adding a monthly recycling figure:**

Open `backend/data/recycling.js`, find the `cardboardData` array, add one line:
```javascript
{ month: 'Jun 2026', kg: 47.5 },
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Site shows 404 | Wait 3 min; check Settings → Pages shows a green confirmed URL |
| Site shows old content | Hard-refresh: **Ctrl+Shift+R** (Windows) or **Cmd+Shift+R** (Mac) |
| Swap form does nothing | Check Railway dashboard — service should show a green dot |
| No Telegram message | Confirm bot is in the group; chat ID must be the negative number |
| "CORS error" in browser | Check `ALLOWED_ORIGINS` in Railway exactly matches your GitHub Pages URL — no trailing slash |
