'use strict';
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── 1. Security headers (Helmet) ────────────────────────────────────────────
// Sets X-Frame-Options, X-Content-Type-Options, HSTS, CSP, etc.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "https://cdnjs.cloudflare.com"],
      styleSrc:    ["'self'", "'unsafe-inline'"],   // inline styles used in HTML
      imgSrc:      ["'self'", "data:"],
      connectSrc:  ["'self'"],                       // API calls only to own origin
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,  // allow Chart.js CDN
}));

// ─── 2. CORS — allow only your own GitHub Pages domain ───────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (origin is undefined for server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods:     ['GET', 'POST', 'PATCH', 'DELETE'],
  credentials: false,
}));

// ─── 3. Body size limit — prevents payload flooding ──────────────────────────
app.use(express.json({ limit: '10kb' }));

// ─── 4. Rate limiting ─────────────────────────────────────────────────────────
// General API limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,                   // 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Stricter limiter for write endpoints (swap submission)
const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,                    // max 10 swap submissions per IP per hour
  message: { error: 'Submission limit reached. Try again in an hour.' },
});

app.use('/api', apiLimiter);
app.use('/api/swap', writeLimiter);  // applied before route mount

// ─── 5. Disable fingerprinting ────────────────────────────────────────────────
app.disable('x-powered-by');  // helmet also does this, but belt-and-suspenders

// ─── 6. Static frontend ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

// ─── 7. API key middleware for write routes ───────────────────────────────────
// Simple shared-secret check for any POST requests
function requireApiKey(req, res, next) {
  const ADMIN_KEY = process.env.ADMIN_API_KEY;
  if (!ADMIN_KEY) return next(); // skip if not configured (dev mode)
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== ADMIN_KEY) {
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
app.use('/api/*', (req, res) => res.status(404).json({ error: 'Not found' }));

// ─── 10. SPA fallback ─────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── 11. Global error handler ─────────────────────────────────────────────────
// Never leak stack traces to the client
app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`🌿 Susty Portal running on port ${PORT}`));
