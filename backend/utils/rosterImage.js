'use strict';
// ─── Roster Calendar Image Generator ─────────────────────────────────────────
// Renders a month's roster_slots as a PNG calendar image (Monday-first grid,
// same color coding as the portal: SAT yellow, SUN green, GPC purple) so it
// can be posted to the Telegram group as a photo, matching what Brendon sees
// on the site, instead of the plain-text roster message.
//
// Deliberately NOT a headless-browser screenshot of the live portal — that
// would require bundling Chromium into the Railway deployment (heavier
// build, more memory/CPU per screenshot, more likely to hit limits on a
// small Railway plan). Instead this builds an SVG string directly from the
// roster data and rasterizes it with `sharp` (native SVG->PNG support,
// lightweight, already battle-tested on Railway-style containers).
//
// ─── Font rendering history (4 Jul 2026) — READ BEFORE TOUCHING FONTS ────────
// Two earlier approaches to getting text to render on Railway BOTH failed,
// confirmed by live tests:
//   1. Embedding fonts as base64 @font-face data URIs inside the SVG —
//      still rendered as tofu boxes. librsvg (which sharp uses to rasterize
//      SVG) does not honor @font-face / embedded fonts at all.
//   2. Installing fontconfig + fonts-dejavu-core via nixpacks.toml so the
//      *system* has real fonts, and referencing them by name ("DejaVu
//      Sans") — STILL rendered as tofu boxes (even worse than before). This
//      means sharp's bundled libvips/librsvg on Railway isn't reliably
//      resolving fonts via fontconfig either (likely a self-contained/
//      statically-linked build that doesn't consult the OS font registry
//      the way a desktop Linux install would).
//
// Given two independent failures of "make the renderer find a font", this
// version sidesteps SVG <text> entirely: it uses `opentype.js` (pure JS, no
// native deps, no reliance on librsvg/fontconfig) to read the bundled
// DejaVu TTF files directly and convert every string into actual vector
// <path> outlines at generation time. The rasterizer never has to resolve
// a font by name — the glyph shapes are already baked into the SVG as
// paths, so this works identically regardless of what fonts (if any) the
// host container has installed.
// ─────────────────────────────────────────────────────────────────────────────

const sharp    = require('sharp');
const opentype = require('opentype.js');
const fs       = require('fs');
const path     = require('path');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
let _fonts = null;
function loadFonts() {
  if (_fonts) return _fonts;
  // opentype.loadSync() is broken in the installed opentype.js@2.0.0 (returns
  // undefined) — use opentype.parse() on the raw buffer directly instead
  // (this is also what opentype.js's own deprecation warning recommends).
  const read = (name) => opentype.parse(fs.readFileSync(path.join(FONT_DIR, name)).buffer);
  _fonts = {
    sans:      read('DejaVuSans.ttf'),
    sansBold:  read('DejaVuSans-Bold.ttf'),
    serifBold: read('DejaVuSerif-Bold.ttf'),
  };
  return _fonts;
}

// Renders `text` as an SVG <path> (real vector glyph outlines, not <text>)
// at baseline (x, y), one character at a time via font.charToGlyph(). This
// deliberately avoids font.getPath(string, ...)/getAdvanceWidth(string, ...)
// — those go through opentype.js's complex-shaping (Bidi/GSUB) pipeline,
// which throws ("substFormat: 2 is not yet supported") on a contextual
// substitution feature present in DejaVu Sans. Per-character glyph lookup
// skips that pipeline entirely; no ligatures/kerning, which doesn't matter
// for a calendar label. anchor: 'start' (default) | 'middle'.
function measureWidth(font, text, fontSize) {
  const scale = fontSize / font.unitsPerEm;
  let w = 0;
  for (const ch of text) w += font.charToGlyph(ch).advanceWidth * scale;
  return w;
}

function textPath(font, text, x, y, fontSize, fill, anchor = 'start') {
  if (!text) return '';
  const scale = fontSize / font.unitsPerEm;
  let cx = anchor === 'middle' ? x - measureWidth(font, text, fontSize) / 2 : x;
  let d = '';
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    d += glyph.getPath(cx, y, fontSize).toPathData(1);
    cx += glyph.advanceWidth * scale;
  }
  return `<path d="${d}" fill="${fill}"/>`;
}

// Pixel-accurate word-wrap (uses real glyph widths instead of a character
// count guess) — wraps `str` into lines no wider than maxWidthPx.
function wrapText(font, str, fontSize, maxWidthPx) {
  const words = String(str).split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (measureWidth(font, candidate, fontSize) > maxWidthPx && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const COLORS = {
  SAT:     { bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },
  SUN:     { bg: '#d1fae5', border: '#10b981', text: '#065f46' },
  GPC:     { bg: '#ede9fe', border: '#8b5cf6', text: '#5b21b6' },
  DEFAULT: { bg: '#e5e7eb', border: '#9ca3af', text: '#374151' },
};

const CELL_W    = 280;
const CELL_H    = 140;
const HEADER_H  = 90;
const DAYHEAD_H = 40;
const PAD       = 24;
const MAX_ENTRIES_PER_DAY = 2; // stack up to 2 duty entries in one day cell; rest collapse into "+N more"

const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const DAY_HEADERS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// "August 2026" or "Aug 2026" -> { year, monthIndex }
function parseMonthLabel(monthLabel) {
  const parts  = monthLabel.trim().split(/\s+/);
  const mIdx   = MONTH_NAMES.findIndex((m) => m.startsWith(parts[0].toLowerCase()));
  const year   = parseInt(parts[1], 10);
  return { year, monthIndex: mIdx };
}

/**
 * Renders a month's roster as a PNG buffer.
 * @param {string} monthLabel e.g. "August 2026"
 * @param {Array<{date: string, session: string, team: string[]}>} slots
 * @returns {Promise<Buffer>}
 */
async function generateRosterImage(monthLabel, slots) {
  const { year, monthIndex } = parseMonthLabel(monthLabel);
  if (isNaN(year) || monthIndex < 0) {
    throw new Error(`generateRosterImage: could not parse month label "${monthLabel}"`);
  }

  const { sans, sansBold, serifBold } = loadFonts();

  const firstOfMonth = new Date(year, monthIndex, 1);
  const daysInMonth  = new Date(year, monthIndex + 1, 0).getDate();
  // getDay(): 0=Sun..6=Sat → convert to Monday-first column: 0=Mon..6=Sun
  const firstCol   = (firstOfMonth.getDay() + 6) % 7;
  const totalCells = firstCol + daysInMonth;
  const rows       = Math.ceil(totalCells / 7);

  const width  = PAD * 2 + CELL_W * 7;
  const height = PAD * 2 + HEADER_H + DAYHEAD_H + CELL_H * rows;

  // Index slots by day-of-month for quick lookup
  const byDay = {};
  for (const s of slots) {
    const d = new Date(`${s.date}T00:00:00`);
    if (d.getFullYear() !== year || d.getMonth() !== monthIndex) continue;
    const day = d.getDate();
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(s);
  }

  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="${width}" height="${height}" fill="#ffffff"/>`;
  svg += textPath(serifBold, monthLabel, width / 2, PAD + 48, 36, '#1f2937', 'middle');

  for (let col = 0; col < 7; col++) {
    const x = PAD + col * CELL_W + CELL_W / 2;
    svg += textPath(sansBold, DAY_HEADERS[col], x, PAD + HEADER_H + 26, 16, '#6b7280', 'middle');
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const cellIndex = firstCol + day - 1;
    const row = Math.floor(cellIndex / 7);
    const col = cellIndex % 7;
    const x = PAD + col * CELL_W;
    const y = PAD + HEADER_H + DAYHEAD_H + row * CELL_H;

    svg += `<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="#ffffff" stroke="#e5e7eb" stroke-width="1.5" rx="6"/>`;
    svg += textPath(sans, String(day), x + 12, y + 26, 16, '#374151');

    const entries   = byDay[day] || [];
    const shown     = entries.slice(0, MAX_ENTRIES_PER_DAY);
    const remaining = entries.length - shown.length;
    let entryY = y + 40;

    for (const entry of shown) {
      const c = COLORS[entry.session] || COLORS.DEFAULT;
      const team = (entry.team || []).join(', ') || '—';
      const teamLines = wrapText(sans, team, 12.5, CELL_W - 28).slice(0, 2);
      const lines = [entry.session || 'Duty', ...teamLines];
      const boxH = 20 + lines.length * 16;

      if (entryY + boxH > y + CELL_H - 6) break; // out of room in this cell

      svg += `<rect x="${x + 8}" y="${entryY}" width="${CELL_W - 16}" height="${boxH}" fill="${c.bg}" stroke="${c.border}" stroke-width="1" rx="4"/>`;
      lines.forEach((line, i) => {
        svg += textPath(i === 0 ? sansBold : sans, line, x + 14, entryY + 16 + i * 16, 12.5, c.text);
      });
      entryY += boxH + 6;
    }

    if (remaining > 0) {
      svg += textPath(sans, `+${remaining} more`, x + 14, entryY + 12, 11, '#9ca3af');
    }
  }

  svg += `</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateRosterImage };
