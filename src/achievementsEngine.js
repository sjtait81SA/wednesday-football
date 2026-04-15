/**
 * Pure evaluation for Wednesday FC achievements (names → types to award for this save).
 * DB inserts happen in App with player UUIDs from `players` table.
 */

export const ACHIEVEMENT_META = {
  on_fire: { emoji: "🔥", label: "On fire — 3+ goals in a match" },
  ghost: { emoji: "👻", label: "Ghost — missed 3 weeks in a row" },
  dave_award: { emoji: "😬", label: "Wooden spoon — most own goals (season)" },
  penalty_merchant: { emoji: "🎯", label: "Penalty merchant — 3+ pens" },
  headers_fc: { emoji: "🗣️", label: "Headers FC — 3+ headers" },
  liability: { emoji: "⚠️", label: "Liability — more OGs than goals (2+ OGs)" },
  golden_boot: { emoji: "👟", label: "Golden boot — top scorer" },
  rode_the_bench: { emoji: "🪑", label: "Rode the bench — 8+ apps, 0 goals" },
};

function normName(n) {
  return (n || "").trim();
}

function rosterForMatch(m) {
  return new Set([
    ...(m.team1?.players || []).map(normName).filter(Boolean),
    ...(m.team2?.players || []).map(normName).filter(Boolean),
  ]);
}

/** Non-OG goals in one match for player */
function nonOgGoalsInMatch(m, playerName) {
  const p = normName(playerName);
  let n = 0;
  (m.events || []).forEach((ev) => {
    if (ev.type !== "goal" || !ev.player || normName(ev.player) !== p) return;
    if (ev.isOG || ev.how === "own_goal") return;
    n += 1;
  });
  return n;
}

function seasonStatsForPlayer(season, playerName) {
  const p = normName(playerName);
  let pens = 0;
  let headers = 0;
  let ogs = 0;
  let goals = 0;
  let apps = 0;
  season.matches.forEach((m) => {
    const r = rosterForMatch(m);
    if (r.has(p)) apps += 1;
    (m.events || []).forEach((ev) => {
      if (ev.type !== "goal" || !ev.player || normName(ev.player) !== p) return;
      if (ev.isOG || ev.how === "own_goal") {
        ogs += 1;
        return;
      }
      goals += 1;
      if (ev.how === "penalty") pens += 1;
      if (ev.how === "header") headers += 1;
    });
  });
  return { pens, headers, ogs, goals, apps };
}

/** Weeks = match index order by date (Wednesdays). Ghost if player missed 3 consecutive matches they could have played (in squad era) — simplified: 3 consecutive matches with no roster appearance. */
function ghostEligible(season, playerName) {
  const p = normName(playerName);
  const sorted = [...season.matches].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  let miss = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = rosterForMatch(sorted[i]);
    if (r.has(p)) {
      miss = 0;
    } else {
      miss += 1;
      if (miss >= 3) return true;
    }
  }
  return false;
}

/**
 * @returns {{ playerName: string, type: string, matchId: string | null }[]}
 */
export function evaluateAchievementsAfterSave(season, savedMatch) {
  const out = [];
  const matchId = savedMatch?.id || null;
  const names = new Set();
  season.matches.forEach((m) => {
    rosterForMatch(m).forEach((n) => names.add(n));
    (m.events || []).forEach((ev) => {
      if (ev.player) names.add(normName(ev.player));
    });
  });

  // on_fire — this match only
  names.forEach((name) => {
    if (nonOgGoalsInMatch(savedMatch, name) >= 3) {
      out.push({ playerName: name, type: "on_fire", matchId });
    }
  });

  // Cumulative / season (re-evaluate everyone)
  const nameList = [...names];
  nameList.forEach((name) => {
    const st = seasonStatsForPlayer(season, name);
    if (st.pens >= 3) out.push({ playerName: name, type: "penalty_merchant", matchId: null });
    if (st.headers >= 3) out.push({ playerName: name, type: "headers_fc", matchId: null });
    if (st.ogs >= 2 && st.ogs > st.goals) out.push({ playerName: name, type: "liability", matchId: null });
    if (st.apps >= 8 && st.goals === 0) out.push({ playerName: name, type: "rode_the_bench", matchId: null });
    if (ghostEligible(season, name)) out.push({ playerName: name, type: "ghost", matchId: null });
  });

  // Top scorers (goals column from seasonGoals logic)
  const goalCounts = {};
  season.matches.forEach((m) => {
    (m.events || []).forEach((ev) => {
      if (ev.type !== "goal" || !ev.player) return;
      if (ev.isOG || ev.how === "own_goal") return;
      const nm = normName(ev.player);
      goalCounts[nm] = (goalCounts[nm] || 0) + 1;
    });
  });
  const maxG = Math.max(0, ...Object.values(goalCounts));
  if (maxG > 0) {
    Object.entries(goalCounts).forEach(([nm, c]) => {
      if (c === maxG) out.push({ playerName: nm, type: "golden_boot", matchId: null });
    });
  }

  const ogCounts = {};
  season.matches.forEach((m) => {
    (m.events || []).forEach((ev) => {
      if (ev.type !== "goal" || !ev.player) return;
      if (!(ev.isOG || ev.how === "own_goal")) return;
      const nm = normName(ev.player);
      ogCounts[nm] = (ogCounts[nm] || 0) + 1;
    });
  });
  const maxOg = Math.max(0, ...Object.values(ogCounts));
  if (maxOg > 0) {
    Object.entries(ogCounts).forEach(([nm, c]) => {
      if (c === maxOg) out.push({ playerName: nm, type: "dave_award", matchId: null });
    });
  }

  return dedupeAwards(out);
}

function dedupeAwards(rows) {
  const seen = new Set();
  const r = [];
  rows.forEach((x) => {
    const k = `${x.playerName}|${x.type}|${x.matchId ?? ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    r.push(x);
  });
  return r;
}
