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
// ─────────────────────────────────────────────────────────────────────────────

const sharp = require('sharp');

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

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

// Rough word-wrap for SVG (no native text wrapping in SVG) — wraps a string
// into lines no longer than maxChars, breaking on word boundaries.
function wrapText(str, maxChars) {
  const words = String(str).split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

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
  svg += `<text x="${width / 2}" y="${PAD + 48}" font-family="Georgia, 'Times New Roman', serif" font-size="36" font-weight="bold" fill="#1f2937" text-anchor="middle">${escapeXml(monthLabel)}</text>`;

  for (let col = 0; col < 7; col++) {
    const x = PAD + col * CELL_W + CELL_W / 2;
    svg += `<text x="${x}" y="${PAD + HEADER_H + 26}" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="#6b7280" text-anchor="middle" letter-spacing="1">${DAY_HEADERS[col]}</text>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const cellIndex = firstCol + day - 1;
    const row = Math.floor(cellIndex / 7);
    const col = cellIndex % 7;
    const x = PAD + col * CELL_W;
    const y = PAD + HEADER_H + DAYHEAD_H + row * CELL_H;

    svg += `<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="#ffffff" stroke="#e5e7eb" stroke-width="1.5" rx="6"/>`;
    svg += `<text x="${x + 12}" y="${y + 26}" font-family="Arial, sans-serif" font-size="16" fill="#374151">${day}</text>`;

    const entries   = byDay[day] || [];
    const shown     = entries.slice(0, MAX_ENTRIES_PER_DAY);
    const remaining = entries.length - shown.length;
    let entryY = y + 40;

    for (const entry of shown) {
      const c = COLORS[entry.session] || COLORS.DEFAULT;
      const team = (entry.team || []).join(', ') || '—';
      const teamLines = wrapText(team, 26).slice(0, 2);
      const lines = [entry.session || 'Duty', ...teamLines];
      const boxH = 20 + lines.length * 16;

      if (entryY + boxH > y + CELL_H - 6) break; // out of room in this cell

      svg += `<rect x="${x + 8}" y="${entryY}" width="${CELL_W - 16}" height="${boxH}" fill="${c.bg}" stroke="${c.border}" stroke-width="1" rx="4"/>`;
      lines.forEach((line, i) => {
        svg += `<text x="${x + 14}" y="${entryY + 16 + i * 16}" font-family="Arial, sans-serif" font-size="12.5" font-weight="${i === 0 ? 'bold' : 'normal'}" fill="${c.text}">${escapeXml(line)}</text>`;
      });
      entryY += boxH + 6;
    }

    if (remaining > 0) {
      svg += `<text x="${x + 14}" y="${entryY + 12}" font-family="Arial, sans-serif" font-size="11" font-style="italic" fill="#9ca3af">+${remaining} more</text>`;
    }
  }

  svg += `</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateRosterImage };
