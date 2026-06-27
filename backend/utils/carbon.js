'use strict';
// ─── Carbon Impact Calculator ─────────────────────────────────────────────────
// Conversion factors used by Singapore ESG practitioners and consistent with
// IPCC/DEFRA 2023 lifecycle analysis for recycled materials.
//
// Sources:
//   Cardboard/Paper: DEFRA 2023 GHG factors (0.70 kg CO2e / kg recycled)
//   PET Plastic:     PlasticsEurope LCA 2023 (1.53 kg CO2e / kg virgin avoided)
//   Trees:           TAPPI — 1 tonne paper requires ~24 trees
//   Car km:          Singapore avg car emission 0.147 kg CO2e/km (LTA 2023)
// ─────────────────────────────────────────────────────────────────────────────

const FACTORS = {
  // kg CO2e avoided per kg recycled (compared to virgin production + landfill)
  cardboard: 0.70,
  plastic:   1.53,

  // Equivalents for context
  treesPerTonnePaper:   24,          // trees saved per 1,000 kg paper recycled
  carKmPerKgCO2:        6.80,        // km of driving per kg CO2e (1 / 0.147)
  plasticBottleGrams:   25,          // avg PET bottle weight in grams
  mealCO2Kg:            2.5,         // avg CO2e of one beef meal (for fun context)
};

/**
 * Calculate CO2e avoided for given recycling weights.
 * @param {number} cardboardKg
 * @param {number} plasticKg
 * @returns {{ co2eKg, cardboardCO2, plasticCO2, treesEquiv, carKmEquiv, bottlesEquiv }}
 */
function calcCO2e(cardboardKg = 0, plasticKg = 0) {
  const cardboardCO2 = round2(cardboardKg * FACTORS.cardboard);
  const plasticCO2   = round2(plasticKg   * FACTORS.plastic);
  const co2eKg       = round2(cardboardCO2 + plasticCO2);

  const treesEquiv   = round2((cardboardKg / 1000) * FACTORS.treesPerTonnePaper);
  const carKmEquiv   = Math.round(co2eKg * FACTORS.carKmPerKgCO2);
  const bottlesEquiv = Math.round((plasticKg * 1000) / FACTORS.plasticBottleGrams);

  return { co2eKg, cardboardCO2, plasticCO2, treesEquiv, carKmEquiv, bottlesEquiv };
}

/**
 * Summarise an array of { cardboard_kg, plastic_kg } monthly rows into
 * yearly totals with carbon impact.
 */
function summariseByYear(rows) {
  const years = {};
  for (const row of rows) {
    const y = row.year || parseInt((row.month || '').slice(-4)) || 0;
    if (!y) continue;
    if (!years[y]) years[y] = { cardboardKg: 0, plasticKg: 0, months: 0 };
    years[y].cardboardKg += Number(row.cardboard_kg || 0);
    years[y].plasticKg   += Number(row.plastic_kg   || 0);
    years[y].months++;
  }

  return Object.entries(years)
    .sort(([a], [b]) => a - b)
    .map(([year, totals]) => ({
      year:        Number(year),
      cardboardKg: round2(totals.cardboardKg),
      plasticKg:   round2(totals.plasticKg),
      totalKg:     round2(totals.cardboardKg + totals.plasticKg),
      months:      totals.months,
      impact:      calcCO2e(totals.cardboardKg, totals.plasticKg),
    }));
}

/**
 * Format a Telegram-ready impact summary string.
 * @param {number} cardboardKg
 * @param {number} plasticKg
 * @param {string} label  e.g. "2026 YTD" or "This session"
 */
function formatImpact(cardboardKg, plasticKg, label = '') {
  const i = calcCO2e(cardboardKg, plasticKg);

  const lines = [
    label ? `<b>${label}</b>` : '',
    `📦 Cardboard: <b>${cardboardKg.toFixed(1)} kg</b> → ${i.cardboardCO2} kg CO₂e avoided`,
    `🍶 Plastic:   <b>${plasticKg.toFixed(1)} kg</b> → ${i.plasticCO2} kg CO₂e avoided`,
    ``,
    `🌍 <b>Total: ${i.co2eKg} kg CO₂e avoided</b>`,
    `🌳 Equivalent to saving ${i.treesEquiv} trees`,
    `🚗 Or taking a car off the road for ${i.carKmEquiv.toLocaleString()} km`,
    i.bottlesEquiv > 0 ? `🧴 ${i.bottlesEquiv.toLocaleString()} plastic bottles diverted from landfill` : '',
  ].filter(Boolean).join('\n');

  return lines;
}

/**
 * Format a YoY comparison string for Telegram.
 * @param {Array} yearSummaries  Output from summariseByYear
 */
function formatYoY(yearSummaries) {
  if (yearSummaries.length < 2) {
    const s = yearSummaries[0];
    if (!s) return '⚠️ Not enough data yet for year-on-year comparison.';
    return `📊 <b>${s.year} (${s.months} months tracked)</b>\n` + formatImpact(s.cardboardKg, s.plasticKg);
  }

  const prev = yearSummaries[yearSummaries.length - 2];
  const curr = yearSummaries[yearSummaries.length - 1];

  // Annualise current year if < 12 months (for fair comparison)
  const annualisedCb = round2(curr.months < 12 ? (curr.cardboardKg / curr.months) * 12 : curr.cardboardKg);
  const annualisedPl = round2(curr.months < 12 ? (curr.plasticKg   / curr.months) * 12 : curr.plasticKg);

  const cbChange  = pctChange(prev.cardboardKg, curr.cardboardKg);
  const plChange  = pctChange(prev.plasticKg,   curr.plasticKg);
  const co2Change = pctChange(prev.impact.co2eKg, curr.impact.co2eKg);

  const arrow = (n) => n > 0 ? '📈' : n < 0 ? '📉' : '➡️';
  const sign  = (n) => n > 0 ? `+${n}%` : `${n}%`;

  const suffix = curr.months < 12
    ? `\n<i>(${curr.year} is ${curr.months}-month actual; annualised pace: ${annualisedCb + annualisedPl} kg total)</i>`
    : '';

  return [
    `📊 <b>Year-on-Year Comparison</b>`,
    ``,
    `<b>${prev.year}</b> (full year)`,
    `  📦 Cardboard: ${prev.cardboardKg} kg`,
    `  🍶 Plastic:   ${prev.plasticKg} kg`,
    `  🌍 CO₂e avoided: ${prev.impact.co2eKg} kg`,
    ``,
    `<b>${curr.year}</b> (${curr.months} months)`,
    `  📦 Cardboard: ${curr.cardboardKg} kg  ${arrow(cbChange)} ${sign(cbChange)}`,
    `  🍶 Plastic:   ${curr.plasticKg} kg  ${arrow(plChange)} ${sign(plChange)}`,
    `  🌍 CO₂e avoided: ${curr.impact.co2eKg} kg  ${arrow(co2Change)} ${sign(co2Change)}`,
    suffix,
  ].filter(s => s !== undefined).join('\n');
}

function round2(n) { return Math.round(n * 100) / 100; }
function pctChange(from, to) {
  if (!from) return to > 0 ? 100 : 0;
  return Math.round(((to - from) / from) * 100);
}

module.exports = { calcCO2e, summariseByYear, formatImpact, formatYoY, FACTORS };
