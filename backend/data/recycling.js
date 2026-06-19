// W2R Recycling data — seeded from Google Drive "Recycling Weekend Roster" tracker
// Update monthly by editing the arrays below or hooking up a Google Sheets sync

const cardboardData = [
  // 2025
  { month: 'Mar 2025', kg: 71.24 },
  { month: 'Apr 2025', kg: 25.02 },
  { month: 'May 2025', kg: 32.50 },
  { month: 'Jun 2025', kg: 60.00 },
  { month: 'Jul 2025', kg: 292.00 }, // GPC'25 bulk
  { month: 'Aug 2025', kg: 52.00 },
  { month: 'Sep 2025', kg: 83.00 },
  { month: 'Oct 2025', kg: 54.00 },
  { month: 'Nov 2025', kg: 46.00 },
  { month: 'Dec 2025', kg: 58.00 },
  // 2026
  { month: 'Jan 2026', kg: 280.00 },
  { month: 'Feb 2026', kg: 48.00 },
  { month: 'Mar 2026', kg: 64.00 },
];

const plasticData = [
  { month: 'Jul 2025', kg: 40.00 },
  { month: 'Sep 2025', kg: 8.00 },
  { month: 'Oct 2025', kg: 9.00 },
  { month: 'Nov 2025', kg: 3.00 },
  { month: 'Dec 2025', kg: 4.00 },
  { month: 'Jan 2026', kg: 13.09 },
  { month: 'Feb 2026', kg: 1.00 },
  { month: 'Mar 2026', kg: 8.00 },
];

function buildSummary(arr) {
  const total = arr.reduce((s, r) => s + r.kg, 0);
  const latest = arr[arr.length - 1];
  return { total: Math.round(total * 100) / 100, latest };
}

module.exports = { cardboardData, plasticData, buildSummary };
