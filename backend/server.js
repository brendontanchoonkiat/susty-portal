'use strict';
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// Railway sits behind a reverse proxy (1 hop) — without this, express-rate-limit
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request (X-Forwarded-For is
// always set by Railway's proxy but Express's default 'trust proxy' is false).
// That validation error was one of the recurring causes of the crash loop found
// 4 Jul 2026 (see process-level safety net below for the other).
app.set('trust proxy', 1);

// Last-resort safety net: log and stay up instead of letting Node kill the
// whole process. Root cause found 4 Jul 2026 — grammY's webhookCallback can
// detach a slow update from its HTTP request after its internal timeout; if
// that detached continuation throws (e.g. answerCallbackQuery on an expired
// callback query), the rejection never reaches bot.catch() and surfaces here
// instead, crashing the entire server (not just that one bot update) and
// triggering a Railway restart loop. All 58 answerCallbackQuery() call sites
// in bot/index.js were also hardened with .catch(() => {}) as the real fix —
// this handler is just the backstop for anything else that slips through.
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection (kept alive):', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception (kept alive):', err?.stack || err);
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://unpkg.com"],
      scriptSrcAttr:   ["'unsafe-inline'"],
      styleSrc:        ["'self'", "'unsafe-inline'"],
      imgSrc:          ["'self'", "data:", "https://*.supabase.co"],
      connectSrc:      ["'self'", "https://*.supabase.co"],
      fontSrc:         ["'self'"],
      objectSrc:       ["'none'"],
      frameAncestors:  ["'none'"],
      formAction:      ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Always trust the app's own canonical URL as an origin, regardless of
// whether ALLOWED_ORIGINS was actually set/updated on Railway — this is the
// frontend's own home (single-file portal served by this same Express app),
// so it must never depend on remembering to add it to an env var. Found
// 9 Jul 2026: ALLOWED_ORIGINS on Railway didn't include this URL, so every
// POST/PATCH/DELETE fetch from the live portal (browsers send an Origin
// header on same-origin state-changing requests) was being CORS-blocked —
// which our old catch-all error handler then surfaced as a generic
// "Internal server error" with no indication it was actually a CORS issue.
const SELF_ORIGIN = 'https://susty-portal-production.up.railway.app';
const ALLOWED_ORIGINS = Array.from(new Set([
  SELF_ORIGIN,
  ...(process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(',').map(o => o.trim()),
]));
if (process.env.NODE_ENV === 'production' && ALLOWED_ORIGINS.includes('http://localhost:3001'))
  console.warn('[SECURITY] ALLOWED_ORIGINS defaulting to localhost — set it in Railway env vars');

app.use(cors({
  origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`)),
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Api-Key'],
  credentials: false, maxAge: 600,
}));

app.use(express.json({ limit: '10kb', strict: true }));
// Comms image upload (POST /api/comms/:id/image) is multipart/form-data,
// not JSON — everything else on POST/PATCH/PUT still has to be JSON. Without
// this exception the strict check below 415'd every image upload before it
// ever reached multer (found 9 Jul 2026 while wiring up the comms planning
// calendar).
const MULTIPART_ROUTES = [/^\/api\/comms\/\d+\/image$/];
app.use((req, res, next) => {
  if (['POST','PATCH','PUT'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    const isMultipartRoute = MULTIPART_ROUTES.some(re => re.test(req.path));
    if (isMultipartRoute && ct.includes('multipart/form-data')) return next();
    if (!ct.includes('application/json'))
      return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
});

const apiLimiter   = rateLimit({ windowMs: 15*60*1000, max: 100,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
const writeLimiter  = rateLimit({ windowMs: 60*60*1000, max: 10,   message: { error: 'Submission limit reached.' } });
const adminLimiter  = rateLimit({ windowMs: 15*60*1000, max: 20,   message: { error: 'Admin rate limit exceeded.' } });

// writeLimiter is meant to throttle SUBMISSIONS (spam swap requests, spam
// comms posts) — but app.use('/api/comms', writeLimiter) applied it to every
// method on that path, including plain GET /api/comms. The frontend re-fetches
// the whole comms list via GET after every single mark-as-posted/revert action,
// so those reads were silently eating the same 10-requests-per-hour budget as
// actual writes — after ~5 mark-as-posted clicks (each = 1 PATCH + 1 GET reload,
// plus page-load GETs), the 11th request of any kind got 429'd, which looked
// like "marking one post blocks marking any more." Fixed by only applying
// writeLimiter to mutating methods; GETs still fall under the more generous
// apiLimiter (100 / 15 min) applied above. Same latent issue existed on
// /api/swap (loadSwaps() GET) — fixed there too since it's the identical bug.
function writeMethodsOnly(limiter) {
  return (req, res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return limiter(req, res, next);
    next();
  };
}

app.use('/api', apiLimiter);
app.use('/api/swap', writeMethodsOnly(writeLimiter));
app.use('/api/comms', writeMethodsOnly(writeLimiter));
app.use('/api/roster', adminLimiter);
app.use('/api/recycling/refresh', adminLimiter);
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, '../frontend'), {
  etag: true, lastModified: true,
  setHeaders: (res) => { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); },
}));

function requireApiKey(req, res, next) {
  const ADMIN_KEY = process.env.ADMIN_API_KEY;
  if (!ADMIN_KEY) return next();
  if ((req.headers['x-api-key'] || '') !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.set('requireApiKey', requireApiKey);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/recycling', require('./routes/recycling'));
app.use('/api/energy',    require('./routes/energy'));
app.use('/api/roster',    require('./routes/roster'));
app.use('/api/comms',     require('./routes/comms'));
app.use('/api/swap',      require('./routes/swap'));
app.use('/api/telegram',  require('./routes/telegram'));
app.use('/api/stats',     require('./routes/stats'));      // carbon + YoY aggregates
app.use('/api/members',  require('./routes/members'));    // member roster + availability (admin)

// ─── Debug: Supabase connectivity check (admin only) ─────────────────────────
app.get('/api/debug', requireApiKey, async (_req, res) => {
  const { getClient } = require('./utils/supabase');
  const supa = getClient();
  const out  = {
    supabaseConfigured: !!supa,
    supabaseUrl:        process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/.*$/, '') + '/...' : null,
    adminKeySet:        !!process.env.ADMIN_API_KEY,
    botTokenSet:        !!process.env.TELEGRAM_BOT_TOKEN,
    tables: {},
  };
  if (supa) {
    for (const t of ['members','roster_slots','recycling_monthly','energy_monthly','data_logs','swap_requests']) {
      try {
        const { count, error } = await supa.from(t).select('*', { count: 'exact', head: true });
        out.tables[t] = error ? `ERROR: ${error.message}` : count;
      } catch (e) { out.tables[t] = `THROW: ${e.message}`; }
    }
  }
  res.json(out);
});

app.use('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return;
  // CORS rejections (thrown by the cors package's origin callback, see
  // above) were previously indistinguishable from a real server crash —
  // both landed here and returned the same generic 500, which is what made
  // the CORS-blocked bug look like an unexplained "Internal server error"
  // on 9 Jul 2026. Surface CORS blocks as their own 403 with the actual
  // reason instead.
  if (err.message?.startsWith('CORS blocked:')) {
    return res.status(403).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Weekly snapshot cron — Monday 09:00 SGT (01:00 UTC) ─────────────────────
function startWeeklyCron() {
  const DAY  = parseInt(process.env.WEEKLY_SNAPSHOT_DAY  ?? '1', 10);
  const HOUR = parseInt(process.env.WEEKLY_SNAPSHOT_HOUR ?? '1', 10);
  let lastFiredKey = '';

  setInterval(async () => {
    const now = new Date();
    if (now.getUTCDay() !== DAY || now.getUTCHours() !== HOUR) return;
    const key = `${now.getUTCDay()}-${now.getUTCHours()}-${now.getUTCDate()}`;
    if (key === lastFiredKey) return;
    lastFiredKey = key;
    console.log('[Cron] Firing weekly snapshot...');
    try {
      const { sendWeeklySnapshot } = require('./utils/weeklySnapshot');
      const result = await sendWeeklySnapshot();
      console.log('[Cron] Sent:', result.ok ? 'ok' : result.reason);
    } catch (err) {
      console.error('[Cron] Failed:', err.message);
    }
  }, 60 * 1000);

  console.log(`🗓  Weekly cron: day=${DAY} hour=${HOUR} UTC (Mon 09:00 SGT)`);
}

app.listen(PORT, () => {
  console.log(`🌿 Susty Portal on port ${PORT}`);
  startWeeklyCron();

  // ─── Start Telegram bot ───────────────────────────────────────────────────
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const { start } = require('./bot/index');
      start();
    } catch (err) {
      console.warn('[Bot] Failed to start:', err.message);
    }

    // ─── Duty reminder cron (daily 09:00 SGT) ──────────────────────────────
    try {
      const { bot }               = require('./bot/index');
      const { startReminderCron } = require('./utils/reminders');
      startReminderCron(bot);
    } catch (err) {
      console.warn('[Reminders] Failed to start:', err.message);
    }
  }
});
