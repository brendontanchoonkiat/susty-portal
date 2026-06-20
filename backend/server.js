'use strict';
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

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

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(',').map(o => o.trim());
if (process.env.NODE_ENV === 'production' && ALLOWED_ORIGINS.includes('http://localhost:3001'))
  console.warn('[SECURITY] ALLOWED_ORIGINS defaulting to localhost — set it in Railway env vars');

app.use(cors({
  origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`)),
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Api-Key'],
  credentials: false, maxAge: 600,
}));

app.use(express.json({ limit: '10kb', strict: true }));
app.use((req, res, next) => {
  if (['POST','PATCH','PUT'].includes(req.method) && !(req.headers['content-type'] || '').includes('application/json'))
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  next();
});

const apiLimiter   = rateLimit({ windowMs: 15*60*1000, max: 100,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests.' } });
const writeLimiter  = rateLimit({ windowMs: 60*60*1000, max: 10,   message: { error: 'Submission limit reached.' } });
const adminLimiter  = rateLimit({ windowMs: 15*60*1000, max: 20,   message: { error: 'Admin rate limit exceeded.' } });

app.use('/api', apiLimiter);
app.use('/api/swap', writeLimiter);
app.use('/api/comms', writeLimiter);
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

app.use('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
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
});
