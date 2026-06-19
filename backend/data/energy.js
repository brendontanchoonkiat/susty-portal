// Energy consumption data — IM Level 3 + Level 4 combined
// Source: Google Sheets "IM Utility - For ESG Team"
// Units: kWh (electricity), m³ (water)
// Jan-24 excluded (meter reading errors in source sheet)
// Jan-25 water corrected from source sheet data entry errors

const electricityData = [
  // 2024
  { month: 'Feb 2024', kwh: 61923  },  // L3: 5510 + L4: 56413
  { month: 'Mar 2024', kwh: 106118 },  // L3: 7160 + L4: 98958
  { month: 'Apr 2024', kwh: 82541  },  // L3: 5560 + L4: 76981
  { month: 'May 2024', kwh: 76651  },  // L3: 7060 + L4: 69591
  { month: 'Jun 2024', kwh: 105525 },  // L3: 7470 + L4: 98055
  { month: 'Jul 2024', kwh: 93129  },  // L3: 5870 + L4: 87259
  { month: 'Aug 2024', kwh: 78230  },  // L3: 6190 + L4: 72040
  { month: 'Sep 2024', kwh: 72153  },  // L3: 6390 + L4: 65763
  { month: 'Oct 2024', kwh: 96710  },  // L3: 7020 + L4: 89690
  { month: 'Nov 2024', kwh: 79667  },  // L3: 4200 + L4: 75467
  { month: 'Dec 2024', kwh: 81574  },  // L3: 5950 + L4: 75624
  // 2025
  { month: 'Jan 2025', kwh: 78683  },  // L3: 5730 + L4: 72953 (corrected)
  { month: 'Feb 2025', kwh: 55745  },  // L3: 4590 + L4: 51155
  { month: 'Mar 2025', kwh: 75655  },  // L3: 5060 + L4: 70595
  { month: 'Apr 2025', kwh: 120426 },  // L3: 8900 + L4: 111526
  { month: 'May 2025', kwh: 54167  },  // L3: 4200 + L4: 49967
  { month: 'Jun 2025', kwh: 103509 },  // L3: 7540 + L4: 95969
  { month: 'Jul 2025', kwh: 84069  },  // L3: 4980 + L4: 79089
  { month: 'Aug 2025', kwh: 90290  },  // L3: 6780 + L4: 83510
  { month: 'Sep 2025', kwh: 78418  },  // L3: 4940 + L4: 73478
  { month: 'Oct 2025', kwh: 91908  },  // L3: 5640 + L4: 86268
  { month: 'Nov 2025', kwh: 85474  },  // L3: 6880 + L4: 78594
  { month: 'Dec 2025', kwh: 73954  },  // L3: 4170 + L4: 69784
  // 2026
  { month: 'Jan 2026', kwh: 94918  },  // L3: 6620 + L4: 88298
  { month: 'Feb 2026', kwh: 35288  },  // L3: 2360 + L4: 32928
  { month: 'Mar 2026', kwh: 97855  },  // L3: 6130 + L4: 91725
  { month: 'Apr 2026', kwh: 90827  },  // L3: 5490 + L4: 85337
];

const waterData = [
  // 2024
  { month: 'Feb 2024', m3: 242 },  // L3: 63 + L4: 179
  { month: 'Mar 2024', m3: 396 },  // L3: 105 + L4: 291
  { month: 'Apr 2024', m3: 366 },  // L3: 80 + L4: 286
  { month: 'May 2024', m3: 270 },  // L3: 85 + L4: 185
  { month: 'Jun 2024', m3: 540 },  // L3: 143 + L4: 397
  { month: 'Jul 2024', m3: 439 },  // L3: 89 + L4: 350
  { month: 'Aug 2024', m3: 336 },  // L3: 94 + L4: 242
  { month: 'Sep 2024', m3: 267 },  // L3: 89 + L4: 178
  { month: 'Oct 2024', m3: 352 },  // L3: 94 + L4: 258
  { month: 'Nov 2024', m3: 356 },  // L3: 72 + L4: 284
  { month: 'Dec 2024', m3: 278 },  // L3: 77 + L4: 201
  // 2025
  { month: 'Jan 2025', m3: 291 },  // L3: 85 (corrected) + L4: 206 (corrected)
  { month: 'Feb 2025', m3: 226 },  // L3: 65 + L4: 161
  { month: 'Mar 2025', m3: 329 },  // L3: 88 + L4: 241
  { month: 'Apr 2025', m3: 547 },  // L3: 168 + L4: 379
  { month: 'May 2025', m3: 198 },  // L3: 55 + L4: 143
  { month: 'Jun 2025', m3: 324 },  // L3: 95 + L4: 229
  { month: 'Jul 2025', m3: 441 },  // L3: 62 + L4: 379
  { month: 'Aug 2025', m3: 355 },  // L3: 77 + L4: 278
  { month: 'Sep 2025', m3: 298 },  // L3: 67 + L4: 231
  { month: 'Oct 2025', m3: 394 },  // L3: 86 + L4: 308
  { month: 'Nov 2025', m3: 384 },  // L3: 81 + L4: 303
  { month: 'Dec 2025', m3: 331 },  // L3: 66 + L4: 265
  // 2026
  { month: 'Jan 2026', m3: 432 },  // L3: 91 + L4: 341
  { month: 'Feb 2026', m3: 118 },  // L3: 22 + L4: 96
  { month: 'Mar 2026', m3: 426 },  // L3: 82 + L4: 344
  { month: 'Apr 2026', m3: 469 },  // L3: 138 + L4: 331
];

module.exports = { electricityData, waterData };
