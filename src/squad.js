/**
 * Wednesday FC squad roster — single source for default season + DB seed list.
 * No roles/tags; names only.
 */
export const WNF_SQUAD = [
  "Steven",
  "Dan",
  "Chris",
  "Tom",
  "Matt",
  "Owen",
  "Cam",
  "Francis",
  "Ho Yin",
  "Brandon",
  "Parthi",
  "Alan",
  "Dimple",
];

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** First-time local state: full squad + one recent match (3–2) with real names only. */
export function buildInitialSeason() {
  const t1 = WNF_SQUAD.slice(0, 7);
  const t2 = WNF_SQUAD.slice(7);
  const matchId = newId();

  const ev = (player, how, team, i) => ({
    id: newId(),
    type: "goal",
    how,
    team,
    player,
    goalX: 48 + i * 2,
    goalY: 52,
    pitchX: 40 + team * 12,
    pitchY: 38,
    quip:
      how === "tap_in"
        ? "Standing there. Waiting. Tap-in."
        : how === "worldie"
          ? "Absolute screamer. He won't shut up about it."
          : how === "header"
            ? "With his head. Respect."
            : how === "penalty"
              ? "Penalty. Long run-up. Keeper barely moved."
              : "Into the net.",
    gmQuip: "Straight down the middle.",
    time: i + 1,
    isOG: false,
  });

  return {
    players: [...WNF_SQUAD],
    matches: [
      {
        id: matchId,
        date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        team1: { name: "Bibs", color: "#f59e0b", players: t1 },
        team2: { name: "Non-Bibs", color: "#3b82f6", players: t2 },
        score1: 3,
        score2: 2,
        motm: "Steven",
        events: [
          ev("Tom", "tap_in", 1, 0),
          ev("Chris", "worldie", 1, 1),
          ev("Steven", "header", 1, 2),
          ev("Dimple", "penalty", 2, 3),
          ev("Ho Yin", "long_range", 2, 4),
        ],
      },
    ],
  };
}
