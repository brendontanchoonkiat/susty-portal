// Energy consumption data — replace with real figures when provided
// Units: kWh (electricity), m³ (water)

const electricityData = [
  { month: 'Jan 2025', kwh: null },
  { month: 'Feb 2025', kwh: null },
  { month: 'Mar 2025', kwh: null },
  { month: 'Apr 2025', kwh: null },
  { month: 'May 2025', kwh: null },
  { month: 'Jun 2025', kwh: null },
  { month: 'Jul 2025', kwh: null },
  { month: 'Aug 2025', kwh: null },
  { month: 'Sep 2025', kwh: null },
  { month: 'Oct 2025', kwh: null },
  { month: 'Nov 2025', kwh: null },
  { month: 'Dec 2025', kwh: null },
  { month: 'Jan 2026', kwh: null },
  { month: 'Feb 2026', kwh: null },
  { month: 'Mar 2026', kwh: null },
];

const waterData = electricityData.map(r => ({ month: r.month, m3: null }));

module.exports = { electricityData, waterData };
