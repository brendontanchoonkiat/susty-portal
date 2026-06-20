'use strict';
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── 1. Security headers (Helmet) ────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      scriptSrc:       ["'self'", "https://cdnjs.cloudflare.com"],
      styleSrc:        ["'self'", "'unsafe-inline'"],
      imgSrc:          ["'self'", "data:"],
      connectSrc:      ["'self'"],
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

// ─── 2. CORS ─────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001')
  .split(',').map(o => o.trim());

if (process.env.NODE_ENV === 'production' && ALLOWED_ORIGINS.includes('http://localhost:3001')) {
  console.warn('[SECURITY] ALLOWED_ORIGINS is defaulting to localhost — set ALLOWED_ORIGINS in Railway env vars');
}

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods:        ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Api-Key'],
  exposedHeaders: [],
  credentials:    false,
  maxAge:         600,
}));

// ─── 3. Body parsing ─────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb', strict: true }));

app.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
  }
  next();
});

// ─── 4. Rate limiting ────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'Submission limit reached. Try again in an hour.' },
});
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Admin rate limit exceeded.' },
});

app.use('/api', apiLimiter);
app.use('/api/swap', writeLimiter);
app.use('/api/comms', writeLimiter);
app.use('/api/roster', adminLimiter);
app.use('/api/recycling/refresh', adminLimiter);

// ─── 5. Disable fingerprinting ────────────────────────────────────────────────
app.disable('x-powered-by');

// ─── 6. Static frontend ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend'), {
  etag: true, lastModified: true,
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
  },
}));

// ─── 7. API key middleware ────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const ADMIN_KEY = process.env.ADMIN_API_KEY;
  if (!ADMIN_KEY) return next();
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== ADMIN_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.set('requireApiKey', requireApiKey);

// ─── 8. Routes ───────────────────────────────────────────────────────────────
const recyclingRoutes = require('./routes/recycling');
const energyRoutes    = require('./routes/energy');
const rosterRoutes    = require('./routes/roster');
const commsRoutes     = require('./routes/comms');
const swapRoutes      = require('./routes/swap');
const telegramRoutes  = require('./routes/telegram');

app.use('/api/recycling', recyclingRoutes);
app.use('/api/energy',    energyRoutes);
app.use('/api/roster',    rosterRoutes);
app.use('/api/comms',     commsRoutes);
app.use('/api/swap',      swapRoutes);
app.use('/api/telegram',  telegramRoutes);

// ─── 9. 404 for unknown API routes ────────────────────────────────────────────
app.use('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── 10. SPA fallback ─────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── 11. Global error handler ─────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// ─── 12. Weekly snapshot cron ────────────────────────────────────────────────
// Fires every Monday at 01:00 UTC = 09:00 SGT automatically on Railway.
// Override: WEEKLY_SNAPSHOT_DAY (0=Sun…6=Sat, default 1) / WEEKLY_SNAPSHOT_HOUR (UTC, default 1)
function startWeeklyCron() {
  const { sendWeeklySnapshot } = require('./utils/weeklySnapshot');
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
      const result = await sendWeeklySnapshot();
      console.log('[Cron] Weekly snapshot sent:', result.ok ? 'ok' : result.reason);
    } catch (err) {
      console.error('[Cron] Weekly snapshot failed:', err.message);
    }
  }, 60 * 1000);

  console.log(`🗓  Weekly snapshot cron started — fires day=${DAY} hour=${HOUR} UTC (Mon 09:00 SGT)`);
}

app.listen(PORT, () => {
  console.log(`🌿 Susty Portal running on port ${PORT}`);
  startWeeklyCron();
});
