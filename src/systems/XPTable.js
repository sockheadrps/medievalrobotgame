// XPTable — RS-inspired exponential XP curve, compressed to ~1.5M XP at level 99.
// Formula: same as RuneScape but divided by 9, so the grind is ~9× shorter.
//
// XP_TABLE[level - 1] = total XP required to reach that level.
// Level 1 = 0 XP, Level 2 = ~83 XP, Level 10 = ~1,200 XP, Level 50 = ~100k XP.

function _build() {
  const table = [0]; // index 0 = level 1 requires 0 XP
  let points = 0;
  for (let l = 1; l <= 98; l++) {
    points += Math.floor(l + 300 * Math.pow(2, l / 7));
    table.push(Math.floor(points / 4 / 9));
  }
  return table;
}

export const XP_TABLE = _build();

/** Returns the level (1-99) for a given total XP amount. */
export function xpToLevel(totalXP) {
  let level = 1;
  while (level < 99 && totalXP >= XP_TABLE[level]) level++;
  return level;
}

/** Returns the total XP required to reach level n (1-99). */
export function xpForLevel(n) {
  return XP_TABLE[Math.min(Math.max(n, 1), 99) - 1];
}

/** Returns how much XP is needed to reach the next level from a given total XP. */
export function xpToNext(totalXP) {
  const lvl = xpToLevel(totalXP);
  if (lvl >= 99) return 0;
  return XP_TABLE[lvl] - totalXP;
}

/** Returns XP progress within the current level as a 0-1 fraction. */
export function xpFraction(totalXP) {
  const lvl = xpToLevel(totalXP);
  if (lvl >= 99) return 1;
  const start = XP_TABLE[lvl - 1];
  const end   = XP_TABLE[lvl];
  return (totalXP - start) / (end - start);
}
