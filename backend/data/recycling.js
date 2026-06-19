// W2R Recycling data — sourced from "Recycling Weekend Roster" Google Sheet
// First collation: Sep 2025. Latest: Jun 2026.

const cardboardData = [
  // 2025 — formal tracking started Sep 2025
  { month: 'Sep 2025', kg: 83.45 },
  { month: 'Oct 2025', kg: 53.62 },
  { month: 'Nov 2025', kg: 46.37 },
  { month: 'Dec 2025', kg: 57.53 },
  // 2026
  { month: 'Jan 2026', kg: 279.70 }, // large camp collection mid-Jan
  { month: 'Feb 2026', kg: 48.00 },
  { month: 'Mar 2026', kg: 64.34 },
  { month: 'Apr 2026', kg: 50.70 },
  { month: 'May 2026', kg: 49.10 },
  { month: 'Jun 2026', kg: 52.30 },
];

const plasticData = [
  // 2025 — plastic tracking started Sep 2025
  { month: 'Sep 2025', kg: 8.01 },
  { month: 'Oct 2025', kg: 9.39 },
  { month: 'Nov 2025', kg: 2.54 },
  { month: 'Dec 2025', kg: 4.47 },
  // 2026
  { month: 'Jan 2026', kg: 13.09 },
  { month: 'Feb 2026', kg: 1.12 },
  { month: 'Mar 2026', kg: 8.24 },
  { month: 'Apr 2026', kg: 2.30 },
  { month: 'May 2026', kg: 5.97 },
  { month: 'Jun 2026', kg: 0.80 },
];

function buildSummary(arr) {
  const total = arr.reduce((s, r) => s + r.kg, 0);
  const latest = arr[arr.length - 1];
  return { total: Math.round(total * 100) / 100, latest };
}

module.exports = { cardboardData, plasticData, buildSummary };
