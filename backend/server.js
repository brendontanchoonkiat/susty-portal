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
      frameAncestors:  ["'none'"],           // prevent clickjacking
      formAction:      ["'self'"],           // restrict form targets
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
  maxAge:         600,  // cache preflight 10 min
}));

// ─── 3. Body parsing — strict mode, 10 kb cap ────────────────────────────────
app.use(express.json({ limit: '10kb', strict: true }));

// Reject write requests without application/json — prevents content-type confusion
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
// General: 100 req / 15 min per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Write limiter for swap + comms POST: 10 req / hour per IP
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Submission limit reached. Try again in an hour.' },
});

// Strict limiter for admin endpoints: 20 req / 15 min per IP
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Admin rate limit exceeded.' },
});

app.use('/api', apiLimiter);
app.use('/api/swap', writeLimiter);
app.use('/api/comms', writeLimiter);    // comms writes also rate-limited
app.use('/api/roster', adminLimiter);   // tighter on roster writes
app.use('/api/recycling/refresh', adminLimiter);

// ─── 5. Disable fingerprinting ────────────────────────────────────────────────
app.disable('x-powered-by');

// ─── 6. Static frontend ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
  },
}));

// ─── 7. API key middleware for admin routes ───────────────────────────────────
function requireApiKey(req, res, next) {
  const ADMIN_KEY = process.env.ADMIN_API_KEY;
  if (!ADMIN_KEY) return next(); // skip if not configured (dev mode)
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== ADMIN_KEY) {
    // Constant-time rejection — don't reveal whether key exists
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
app.set('requireApiKey', requireApiKey);

// ─── 8. Routes ───────────────────────────────────────────────────────────────
const recyclingRoutes = require('./routes/recycling');
const energyRoutes    = require('./routes/energy');
const rosterRoutes    = require('./routes/roster');
const commsRoutes     = require('./routes/comms');
const swapRoutes      = require('./routes/swap');

app.use('/api/recycling', recyclingRoutes);
app.use('/api/energy',    energyRoutes);
app.use('/api/roster',    rosterRoutes);
app.use('/api/comms',     commsRoutes);
app.use('/api/swap',      swapRoutes);

// ─── 9. 404 for unknown API routes ────────────────────────────────────────────
app.use('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── 10. SPA fallback ─────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── 11. Global error handler — never leak stack traces ───────────────────────
app.use((err, req, res, _next) => {
  // Log full error server-side; send nothing useful to client
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`🌿 Susty Portal running on port ${PORT}`));
