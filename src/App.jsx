import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "./supabase.js";
import { ACHIEVEMENT_META } from "./achievementsEngine.js";
import {
  sendMagicLinkEmail,
  signOut,
  fetchMyPlayer,
  fetchUnclaimedPlayersForSquad,
  claimPlayerRow,
  insertPlayerRow,
  processAchievementsForSavedMatch,
  deleteAchievementsForMatchIds,
  fetchAchievementsForPlayer,
  fetchLatestAchievementFeed,
  syncSquadNamesToPlayers,
  fetchPlayerByName,
  seedPlayersIfEmpty,
} from "./authApi.js";
import { buildInitialSeason } from "./squad.js";

const WNF_PENDING_AUTH_KEY = "wnf-pending-auth";

function readAndClearPendingAuth() {
  try {
    const raw = sessionStorage.getItem(WNF_PENDING_AUTH_KEY);
    if (raw) sessionStorage.removeItem(WNF_PENDING_AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePendingAuth(payload) {
  try {
    sessionStorage.setItem(WNF_PENDING_AUTH_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

// ── Storage (local fallback when Supabase is unavailable) ───────────────────
const SK = "wnf-v2";
const SEASON_ID = "wednesday-fc";

const loadLocal = () => {
  try {
    const r = localStorage.getItem(SK);
    return r ? JSON.parse(r) : null;
  } catch {
    return null;
  }
};

const saveLocal = (s) => {
  try {
    localStorage.setItem(SK, JSON.stringify(s));
  } catch {}
};

/** Legacy default side name; rename on load so UI matches current terminology. */
function migrateTeamName(t) {
  if (!t || typeof t !== "object") return t;
  const raw = typeof t.name === "string" ? t.name.trim() : "";
  if (raw.toLowerCase() !== "skins") return t;
  return { ...t, name: "Non-Bibs" };
}

function migrateMatchTeams(m) {
  if (!m || typeof m !== "object") return m;
  return { ...m, team1: migrateTeamName(m.team1), team2: migrateTeamName(m.team2) };
}

function normalizeSeason(s) {
  if (!s || typeof s !== "object") return { matches: [], players: [] };
  const rawMatches = Array.isArray(s.matches) ? s.matches : [];
  return {
    matches: rawMatches.map(migrateMatchTeams),
    players: Array.isArray(s.players) ? s.players : [],
  };
}

async function fetchSeasonFromSupabase() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("seasons")
    .select("data")
    .eq("id", SEASON_ID)
    .maybeSingle();
  if (error) throw error;
  if (data?.data == null) return null;
  return normalizeSeason(data.data);
}

async function upsertSeasonToSupabase(season) {
  if (!supabase) return;
  const { error } = await supabase.from("seasons").upsert(
    {
      id: SEASON_ID,
      data: season,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );
  if (error) throw error;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const HOW_OPTIONS = [
  { value: "tap_in",      label: "Tap-in 🦶",              quip: "Standing there. Waiting. Tap-in." },
  { value: "worldie",     label: "Worldie 🚀",              quip: "Absolute screamer. He won't shut up about it." },
  { value: "deflection",  label: "Lucky deflection 😬",     quip: "Off his shin. Into the net. He'll take it." },
  { value: "header",      label: "Header 🗣️",               quip: "With his head. Respect." },
  { value: "penalty",     label: "Pen 🥱",                  quip: "Penalty. Long run-up. Keeper barely moved." },
  { value: "own_goal",    label: "Own goal 😭",             quip: "Don't ask. He knows." },
  { value: "long_range",  label: "Long range 💥",           quip: "From distance. No right to go in." },
  { value: "assist_tap",  label: "Five-yard assist 🎯",     quip: "Square ball. 'That's an assist.'" },
];

/** gmQuip from shot placement in goal (0–100) + pitch position. */
function buildGoalQuip(goalX, goalY, pitchX, pitchY) {
  const gx = goalX ?? 50;
  const gy = goalY ?? 50;
  const px = pitchX ?? 50;
  const py = pitchY ?? 50;

  const isTop = gy < 35;
  const isBottom = gy > 65;
  const isLeft = gx < 30;
  const isRight = gx > 70;
  const isHorizMid = gx >= 30 && gx <= 70;

  let core;
  if (isTop && isLeft) core = "Top left corner.";
  else if (isTop && isRight) core = "Top right corner.";
  else if (isTop && isHorizMid) core = "Top centre.";
  else if (isBottom && isLeft) core = "Bottom left.";
  else if (isBottom && isRight) core = "Bottom right.";
  else if (isBottom && isHorizMid) core = "Bottom centre.";
  else if (!isTop && !isBottom && isLeft) core = "Middle left.";
  else if (!isTop && !isBottom && isRight) core = "Middle right.";
  else if (!isTop && !isBottom && isHorizMid) core = "Straight down the middle.";
  else core = "Into the net.";

  const extras = [];
  if (px < 30 || px > 70) extras.push("Tight angle.");
  if (py > 70) extras.push("Point blank.");

  return extras.length ? `${core} ${extras.join(" ")}`.trim() : core;
}

/** Goal mouth from wnf_pitch_and_goal.html: sky + striped pitch + grid net + white frame; 0–100 maps to inner goal area. */
const GM = { vbW: 400, vbH: 150, innerX: 18, innerY: 22, innerW: 364, innerH: 94 };

function goalPxToStored(cx, cy) {
  const gx = Math.max(0, Math.min(100, ((cx - GM.innerX) / GM.innerW) * 100));
  const gy = Math.max(0, Math.min(100, ((cy - GM.innerY) / GM.innerH) * 100));
  return { gx, gy };
}

function storedToGoalPx(gx, gy) {
  return {
    cx: GM.innerX + (gx / 100) * GM.innerW,
    cy: GM.innerY + (gy / 100) * GM.innerH,
  };
}

function GoalmouthSVG({ dot, onGoalTap }) {
  const handlePointer = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width) * GM.vbW;
    const cy = ((e.clientY - rect.top) / rect.height) * GM.vbH;
    const { gx, gy } = goalPxToStored(cx, cy);
    onGoalTap(gx, gy);
  };

  const showDot = dot != null && dot.x != null && dot.y != null;
  const { cx: dotCx, cy: dotCy } = showDot ? storedToGoalPx(dot.x, dot.y) : { cx: -99, cy: -99 };

  const netVertXs = [62, 106, 150, 194, 238, 282, 326, 370];
  const pitchStripeXs = [0, 100, 200, 300];

  return (
    <div className="goalmouth-stage">
      <div className="goalmouth-wrap">
        <svg
          className="goalmouth-svg"
          viewBox={`0 0 ${GM.vbW} ${GM.vbH}`}
          preserveAspectRatio="xMidYMid meet"
          onClick={handlePointer}
          role="img"
          aria-label="Tap where the ball went in the goal"
        >
          <rect width={GM.vbW} height={GM.vbH} fill="#7ab8d4" />
          <rect y="108" width={GM.vbW} height="42" fill="#2e8b3a" />
          {pitchStripeXs.map((x) => (
            <rect key={x} y="108" x={x} width="50" height="42" fill="#287834" opacity={0.5} />
          ))}
          <line x1="0" y1="116" x2="400" y2="116" stroke="rgba(255,255,255,0.7)" strokeWidth="2" />
          <rect x="18" y="28" width="364" height="88" fill="#0d2010" />
          {netVertXs.map((x) => (
            <line key={x} x1={x} y1="28" x2={x} y2="116" stroke="rgba(255,255,255,0.15)" strokeWidth="0.8" />
          ))}
          <line x1="18" y1="50" x2="382" y2="50" stroke="rgba(255,255,255,0.15)" strokeWidth="0.8" />
          <line x1="18" y1="72" x2="382" y2="72" stroke="rgba(255,255,255,0.15)" strokeWidth="0.8" />
          <line x1="18" y1="94" x2="382" y2="94" stroke="rgba(255,255,255,0.15)" strokeWidth="0.8" />
          <rect x="10" y="24" width="8" height="92" rx="3" fill="#f0f0f0" />
          <rect x="382" y="24" width="8" height="92" rx="3" fill="#f0f0f0" />
          <rect x="10" y="22" width="380" height="8" rx="3" fill="#f0f0f0" />
          <rect x="10" y="114" width="380" height="4" rx="2" fill="rgba(220,220,220,0.6)" />
          {showDot && (
            <>
              <circle cx={dotCx} cy={dotCy} r="22" fill="#f0c040" opacity={0.2} />
              <circle
                cx={dotCx}
                cy={dotCy}
                r="10"
                fill="#f0c040"
                stroke="#fff"
                strokeWidth="2.5"
              />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

const BANTER_LINES = {
  topScorer: (name, n) => `🔥 ${name} is on a tear — ${n} goals this season. Someone please mark him.`,
  ogKing: (name, n) => `😭 ${name} has ${n} own goal${n>1?"s":""}. ${n>=3?"Unreal. Genuinely unreal.":n>=2?"Getting a habit.":"Just the once. So far."}`,
  ghost: (name, n) => `👻 ${name} hasn't shown up in ${n} weeks. We've stopped saving him a bib.`,
  winStreak: (team, n) => `📈 ${team} on a ${n}-game win streak. Getting a bit boring if we're honest.`,
  default: () => `📅 Same time, same place, same excuses. See you Wednesday.`,
};

const defaultState = {
  season: { matches: [], players: [] },
  currentMatch: null,
  view: "dashboard",
  logStep: null, // null | "pitch" | "goalmouth" | "how"
  logData: {},
  playerProfileName: null,
};

/** First visit (no localStorage): real squad + one demo match. */
function createInitialClientState() {
  return {
    ...defaultState,
    season: normalizeSeason(buildInitialSeason()),
  };
}

const ALLOWED_VIEWS = [
  "dashboard",
  "new_match",
  "live",
  "squad",
  "history",
  "profile",
  "player_profile",
  "account",
];

/** Merge saved localStorage with defaults so a bad/corrupt snapshot never crashes the first render. */
function sanitizeAppState(raw) {
  if (!raw || typeof raw !== "object") return { ...defaultState };
  const playerProfileName =
    typeof raw.playerProfileName === "string" ? raw.playerProfileName : null;
  let view =
    typeof raw.view === "string" && ALLOWED_VIEWS.includes(raw.view)
      ? raw.view
      : defaultState.view;
  if (view === "player_profile" && !playerProfileName) view = defaultState.view;
  return {
    ...defaultState,
    ...raw,
    season: normalizeSeason(raw.season),
    currentMatch:
      raw.currentMatch != null && typeof raw.currentMatch === "object"
        ? migrateMatchTeams(raw.currentMatch)
        : null,
    view,
    playerProfileName,
    logStep: raw.logStep === null || typeof raw.logStep === "string" ? raw.logStep : null,
    logData:
      raw.logData && typeof raw.logData === "object" && !Array.isArray(raw.logData)
        ? raw.logData
        : {},
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function initials(name) {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0,2);
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function generateBanter(season) {
  const lines = [];
  const goals = {};
  const ogs = {};
  const apps = {};
  season.matches.forEach(m => {
    (m.events || []).forEach(ev => {
      if (ev.player) {
        apps[ev.player] = (apps[ev.player] || 0);
        if (ev.how === "own_goal") ogs[ev.player] = (ogs[ev.player] || 0) + 1;
        else if (ev.type === "goal") goals[ev.player] = (goals[ev.player] || 0) + 1;
      }
    });
  });
  const topScorer = Object.entries(goals).sort((a,b) => b[1]-a[1])[0];
  if (topScorer && topScorer[1] >= 2) lines.push(BANTER_LINES.topScorer(topScorer[0], topScorer[1]));
  const ogKing = Object.entries(ogs).sort((a,b) => b[1]-a[1])[0];
  if (ogKing) lines.push(BANTER_LINES.ogKing(ogKing[0], ogKing[1]));
  if (!lines.length) lines.push(BANTER_LINES.default());
  lines.push(`📅 Next Wednesday — usual spot, usual time, usual excuses.`);
  return lines;
}
function seasonGoals(season) {
  const goals = {};
  season.matches.forEach(m => {
    (m.events || []).forEach(ev => {
      if (ev.type === "goal" && ev.how !== "own_goal" && ev.player) {
        goals[ev.player] = (goals[ev.player] || 0) + 1;
      }
    });
  });
  return Object.entries(goals).sort((a,b) => b[1]-a[1]);
}
function seasonOGs(season) {
  const ogs = {};
  season.matches.forEach(m => {
    (m.events || []).forEach(ev => {
      if (ev.how === "own_goal" && ev.player) {
        ogs[ev.player] = (ogs[ev.player] || 0) + 1;
      }
    });
  });
  return Object.entries(ogs).sort((a,b) => b[1]-a[1]);
}

function playerSeasonStats(season, playerName) {
  const p = (playerName || "").trim();
  if (!p) return { goals: 0, ogs: 0, apps: 0 };
  let goals = 0;
  let ogs = 0;
  let apps = 0;
  season.matches.forEach((m) => {
    const roster = new Set([
      ...(m.team1?.players || []),
      ...(m.team2?.players || []),
    ].map((x) => (x || "").trim()));
    if (roster.has(p)) apps += 1;
    (m.events || []).forEach((ev) => {
      if (ev.type !== "goal" || (ev.player || "").trim() !== p) return;
      if (ev.isOG || ev.how === "own_goal") ogs += 1;
      else goals += 1;
    });
  });
  return { goals, ogs, apps };
}

// ── Styles (injected) ─────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Figtree',sans-serif;background:#f5f5f0;min-height:100vh;color:#111}
.app{max-width:min(1100px,100%);margin:0 auto;padding:16px;padding-bottom:80px;display:flex;flex-direction:column;gap:12px}
.dashboard-grid{display:grid;grid-template-columns:1fr;gap:10px}
@media (min-width:700px){
  .dashboard-grid{grid-template-columns:3fr 2fr;align-items:start}
  .sidebar{display:flex;flex-direction:column;gap:10px}
}
.main-col{display:flex;flex-direction:column;gap:10px}
.dashboard-mini-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.dashboard-mini-stat{text-align:center;padding:12px 8px!important}
.dashboard-mini-stat-val{font-size:22px;font-weight:900;color:#111;line-height:1.1}
.dashboard-mini-stat-lbl{font-size:10px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:0.5px;margin-top:6px}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:4px 0 8px}
.topbar-logo{font-size:20px;font-weight:900;letter-spacing:-0.5px;color:#111}
.topbar-week{font-size:12px;color:#777;background:#fff;padding:4px 12px;border-radius:20px;border:0.5px solid #e0e0e0}
.card{background:#fff;border-radius:18px;border:0.5px solid #e8e8e8;padding:18px}
.card-sm{padding:14px}
.section-label{font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.match-card{}
.score-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.score-team{text-align:center;flex:1}
.score-team-name{font-size:13px;font-weight:600;color:#777;margin-bottom:4px}
.score-num{font-size:56px;font-weight:900;color:#111;line-height:1}
.score-vs{font-size:18px;font-weight:500;color:#bbb;padding:0 8px}
.winner-badge{display:inline-block;background:#eaf3de;color:#27500a;font-size:11px;font-weight:700;padding:4px 14px;border-radius:20px}
.draw-badge{display:inline-block;background:#f5f5f0;color:#666;font-size:11px;font-weight:700;padding:4px 14px;border-radius:20px}
.match-footer{display:flex;justify-content:space-between;padding-top:12px;border-top:0.5px solid #f0f0f0;margin-top:12px;font-size:12px;color:#999}
.goal-item{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:0.5px solid #f5f5f0}
.goal-item:last-child{border-bottom:none;padding-bottom:0}
.goal-icon{font-size:15px;width:30px;height:30px;border-radius:8px;background:#f5f5f0;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.goal-name{font-size:14px;font-weight:700;color:#111}
.goal-desc{font-size:12px;color:#888;margin-top:2px}
.goal-time{font-size:11px;color:#bbb;flex-shrink:0;margin-top:3px;font-weight:600}
.goal-del{background:none;border:none;color:#ddd;cursor:pointer;font-size:16px;line-height:1;flex-shrink:0;padding:0;margin-top:3px}
.goal-del:hover{color:#e24b4a}
.stats-2col{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.stat-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.stat-row:last-child{margin-bottom:0}
.avatar{width:28px;height:28px;border-radius:50%;background:#e6f1fb;color:#0c447c;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0}
.avatar-og{background:#fcebeb;color:#791f1f}
.avatar-lg{width:46px;height:46px;font-size:16px;font-weight:900}
.avatar-amber{background:#faeeda;color:#633806}
.stat-name{font-size:13px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat-val{font-size:14px;font-weight:800;color:#111}
.bar-wrap{height:3px;background:#f0f0f0;border-radius:2px;margin-top:3px}
.bar{height:3px;border-radius:2px;background:#378add}
.bar-og{background:#e24b4a}
.motm-card{display:flex;align-items:center;gap:14px}
.motm-name{font-size:18px;font-weight:900;color:#111}
.motm-sub{font-size:12px;color:#999;margin-top:2px}
.banter-item{display:flex;gap:10px;padding:10px 0;border-bottom:0.5px solid #f5f5f0;align-items:flex-start;font-size:13px;color:#333;line-height:1.5}
.banter-item:last-child{border-bottom:none;padding-bottom:0}
.banter-icon{font-size:18px;width:26px;flex-shrink:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:12px 20px;border-radius:12px;font-family:'Figtree',sans-serif;font-weight:700;font-size:14px;cursor:pointer;border:none;transition:opacity 0.15s}
.btn:active{opacity:0.8}
.btn-primary{background:#111;color:#fff;width:100%}
.btn-green{background:#27500a;color:#fff}
.btn-ghost{background:#f5f5f0;color:#333;border:0.5px solid #e0e0e0}
.btn-danger{background:#fcebeb;color:#791f1f}
.btn-sm{padding:8px 14px;font-size:13px;border-radius:10px}
.btn-row{display:flex;gap:8px;flex-wrap:wrap}
.nav{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:0.5px solid #e8e8e8;display:flex;z-index:100}
.nav-btn{flex:1;padding:12px 0 10px;background:none;border:none;font-family:'Figtree',sans-serif;font-size:11px;font-weight:600;color:#bbb;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;text-transform:uppercase;letter-spacing:0.5px}
.nav-btn.active{color:#111}
.nav-icon{font-size:20px}
.pill{display:inline-block;background:#f5f5f0;color:#888;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;margin-left:6px}
.pill-green{background:#eaf3de;color:#27500a}
.form-group{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.form-group:last-child{margin-bottom:0}
.form-label{font-size:12px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:0.5px}
.form-input{padding:10px 14px;border-radius:10px;border:1px solid #e8e8e8;font-family:'Figtree',sans-serif;font-size:14px;background:#fff;color:#111;outline:none}
.form-input:focus{border-color:#378add}
.form-select{padding:10px 14px;border-radius:10px;border:1px solid #e8e8e8;font-family:'Figtree',sans-serif;font-size:14px;background:#fff;color:#111;outline:none;appearance:none;width:100%}
.player-tag{display:flex;align-items:center;justify-content:space-between;background:#f5f5f0;border-radius:8px;padding:8px 12px;font-size:14px;font-weight:500}
.player-tag button{background:none;border:none;color:#bbb;cursor:pointer;font-size:16px;line-height:1;padding:0}
.player-tag button:hover{color:#e24b4a}
.player-list{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.teams-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.team-label{font-size:12px;font-weight:800;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.team-dot{width:10px;height:10px;border-radius:50%}
.setup-header-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.setup-title{font-weight:900;font-size:22px;color:#111;letter-spacing:-0.3px;margin:0}
.setup-counter-pill{font-size:12px;font-weight:600;color:#666;background:#ececea;border-radius:999px;padding:6px 12px;white-space:nowrap}
.setup-team-card{background:#fff;border-radius:16px;padding:14px 14px 16px;border:1px solid #eee}
.setup-team-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.setup-team-title{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.setup-team-name-input{background:none;border:none;font-family:inherit;font-weight:800;font-size:15px;color:#111;outline:none;min-width:0;flex:1}
.setup-team-count{font-size:12px;font-weight:600;color:#999;white-space:nowrap}
.setup-team-avatars{display:flex;flex-wrap:wrap;gap:8px;min-height:40px;align-items:center}
.setup-avatar-btn{width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;padding:0;flex-shrink:0;transition:transform 0.12s,box-shadow 0.12s}
.setup-avatar-btn:hover{transform:scale(1.06);box-shadow:0 2px 8px rgba(0,0,0,0.12)}
.setup-avatar-btn:active{transform:scale(0.98)}
.setup-team-empty{font-size:13px;color:#bbb;text-align:center;padding:12px 8px}
.setup-pool-card{background:#fff;border-radius:16px;padding:16px;border:1px solid #eee;margin-top:12px}
.setup-pool-label{font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px}
.setup-search{width:100%;box-sizing:border-box;margin-bottom:12px}
.setup-pool-chips{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}
.setup-chip-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.setup-chip{display:inline-flex;align-items:center;gap:8px;padding:8px 12px 8px 8px;border-radius:999px;border:1px solid #e8e8e8;background:#f7f7f5;font-size:13px;font-weight:600;color:#333;cursor:pointer;font-family:inherit;transition:background 0.15s,border-color 0.15s}
.setup-chip:hover{background:#efefec;border-color:#ddd}
.setup-chip-av{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff;flex-shrink:0}
.setup-picker{display:flex;gap:8px;flex-wrap:wrap;padding-left:2px}
.setup-picker .btn{min-width:88px}
.setup-pool-hint{font-size:13px;color:#999;margin-top:8px;line-height:1.4}
.setup-pool-done{font-size:14px;font-weight:600;color:#27500a;margin-top:4px}
.setup-guest-link{display:block;width:100%;text-align:center;margin-top:14px;padding:8px;background:none;border:none;font-size:13px;font-weight:600;color:#888;cursor:pointer;font-family:inherit;text-decoration:underline;text-underline-offset:3px}
.setup-guest-link:hover{color:#555}
.setup-guest-panel{margin-top:10px;padding-top:12px;border-top:1px solid #f0f0f0}
.setup-footer-btns{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
.setup-footer-btns .btn{flex:1;min-width:120px;border-radius:14px;padding:12px 16px;font-weight:700}
.pitch-svg{width:100%;border-radius:12px;cursor:crosshair;display:block}
.pitch-tap-hint{font-size:12px;color:#999;text-align:center;margin-top:8px}
.how-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.how-btn{padding:12px;border-radius:12px;border:1px solid #e8e8e8;background:#fff;font-family:'Figtree',sans-serif;font-size:13px;font-weight:600;cursor:pointer;text-align:left;transition:border-color 0.15s}
.how-btn:hover{border-color:#111;background:#f9f9f9}
.goalmouth-stage{width:100%;padding:4px 0 10px}
.goalmouth-wrap{position:relative;width:100%;height:0;padding-bottom:37.5%;border-radius:14px;overflow:hidden;border:2px solid #e0e0e0;box-shadow:0 1px 3px rgba(0,0,0,0.06)}
.goalmouth-svg{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair;touch-action:manipulation;border-radius:12px}
.goalmouth-hint{font-size:12px;color:#999;text-align:center;margin-top:10px}
.squad-pick-list{display:flex;flex-direction:column;gap:0}
.squad-pick-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:0.5px solid #f0f0f0}
.squad-pick-row:last-child{border-bottom:none}
.squad-pick-actions{display:flex;gap:8px;flex-shrink:0}
.squad-pick-name{font-size:14px;font-weight:600;color:#111;flex:1;min-width:0}
.guest-add-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
.guest-add-row .form-input{flex:1;min-width:140px}
.back-btn{display:flex;align-items:center;gap:6px;background:none;border:none;font-family:'Figtree',sans-serif;font-size:14px;font-weight:600;color:#555;cursor:pointer;padding:0;margin-bottom:4px}
.step-indicator{display:flex;gap:6px;align-items:center;margin-bottom:16px}
.step-dot{width:6px;height:6px;border-radius:50%;background:#e0e0e0}
.step-dot.done{background:#111}
.step-dot.active{background:#111;width:18px;border-radius:3px}
.no-matches{text-align:center;padding:32px 16px;color:#bbb;font-size:14px}
.match-history-item{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 0;border-bottom:0.5px solid #f5f5f0}
.match-history-item:last-child{border-bottom:none}
.match-history-item .mhi-block{flex:1;min-width:0}
.match-history-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end}
.mhi-score{font-size:18px;font-weight:900}
.mhi-teams{font-size:12px;color:#999;margin-top:2px}
.mhi-date{font-size:12px;color:#bbb;font-weight:500}
.empty-state{text-align:center;color:#bbb;font-size:13px;padding:20px 0}
.divider{border:none;border-top:0.5px solid #f0f0f0;margin:4px 0}
.motm-select{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.motm-option{padding:10px;border-radius:10px;border:1px solid #e8e8e8;background:#fff;font-family:'Figtree',sans-serif;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px}
.motm-option:hover{border-color:#111}
.motm-option.selected{border-color:#f0c040;background:#fafbde}
.score-adj{display:flex;align-items:center;gap:12px}
.score-adj-btn{width:36px;height:36px;border-radius:8px;border:1px solid #e8e8e8;background:#f5f5f0;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:500;color:#333}
.live-score{font-size:40px;font-weight:900;min-width:50px;text-align:center}
.shot-marker{cursor:pointer}
.shot-marker:hover circle{stroke:#e24b4a;stroke-width:0.8}
.stat-row--me{background:#f0f7ff;border-radius:10px;padding:6px 8px;margin:-6px -8px 2px}
.stat-row--me .stat-name{color:#0c447c}
.auth-screen{min-height:70vh;display:flex;flex-direction:column;justify-content:center;gap:16px;max-width:400px;margin:0 auto;padding:24px 16px}
.auth-title{font-size:28px;font-weight:900;letter-spacing:-0.5px;text-align:center}
.auth-card{background:#fff;border-radius:18px;border:0.5px solid #e8e8e8;padding:20px}
.auth-hint{font-size:12px;color:#888;text-align:center;margin-top:8px}
.auth-err{font-size:13px;color:#c0392b;text-align:center;margin-top:8px}
.claim-list{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.claim-row{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:12px;border:1px solid #e8e8e8;background:#fff;font-size:15px;font-weight:600;cursor:pointer;text-align:left;width:100%;font-family:inherit}
.claim-row:disabled{opacity:0.6;cursor:not-allowed}
.claim-row:not(:disabled):active{background:#f5f5f0}
.topbar-user{display:flex;align-items:center;gap:8px}
.avatar-btn{width:36px;height:36px;border-radius:50%;border:2px solid #e8e8e8;background:#e6f1fb;color:#0c447c;font-size:11px;font-weight:800;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}
.avatar-btn:active{opacity:0.85}
.ach-feed-card{background:linear-gradient(135deg,#fff9e6 0%,#fff 100%);border:1px solid #f0e6c8;border-radius:14px;padding:14px 16px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start}
.ach-feed-emoji{font-size:28px;line-height:1}
.ach-feed-text{font-size:14px;color:#333;line-height:1.4}
.ach-feed-text strong{font-weight:800}
.profile-badges{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.ach-badge{font-size:26px;line-height:1;padding:8px 10px;border-radius:12px;background:#f5f5f0;border:1px solid #e8e8e8;cursor:default}
.toast-mini{position:fixed;bottom:88px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:12px;font-size:13px;font-weight:600;z-index:200;max-width:90%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.15)}
.btn:disabled{opacity:0.45;cursor:not-allowed}
.stat-row--click{cursor:pointer;border-radius:10px;transition:background 0.15s}
.stat-row--click:hover{background:#fafafa}
.auth-sheet-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:300;display:flex;align-items:flex-end;justify-content:center}
.auth-sheet-backdrop--center{align-items:center;justify-content:center;padding:24px}
.auth-sheet{width:100%;max-width:440px;background:#fff;border-radius:20px 20px 0 0;padding:20px 20px 28px;box-shadow:0 -8px 40px rgba(0,0,0,0.12);max-height:85vh;overflow:auto}
.auth-sheet--modal{border-radius:20px;margin:0 auto}
.auth-sheet-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}
.auth-sheet-title{font-size:20px;font-weight:900;letter-spacing:-0.3px;color:#111}
.auth-sheet-sub{font-size:14px;color:#666;line-height:1.45;margin-bottom:16px}
.auth-sheet-close{width:36px;height:36px;border:none;background:#f5f5f0;border-radius:10px;font-size:20px;line-height:1;cursor:pointer;color:#666;flex-shrink:0}
.auth-sheet-close:hover{background:#ebebeb}
.topbar-link{background:none;border:none;font-size:13px;font-weight:600;color:#888;cursor:pointer;padding:6px 4px;font-family:inherit;text-decoration:underline;text-underline-offset:3px}
.topbar-link:hover{color:#111}
`;

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState(() => sanitizeAppState(loadLocal() ?? createInitialClientState()));
  const [session, setSession] = useState(null);
  const [myPlayer, setMyPlayer] = useState(null);
  const [authModal, setAuthModal] = useState({ open: false, subtitle: "" });
  const [claimSheetOpen, setClaimSheetOpen] = useState(false);
  /** When opening sign-in: `{ kind, meta }` written to sessionStorage after magic link is sent. */
  const pendingAuthRef = useRef(null);
  const [magicLinkStep, setMagicLinkStep] = useState("email");
  const [emailInput, setEmailInput] = useState("");
  const [authErr, setAuthErr] = useState("");
  const [claimLoading, setClaimLoading] = useState(false);
  const [guestClaimName, setGuestClaimName] = useState("");
  const [unclaimedList, setUnclaimedList] = useState([]);
  const [latestAchNotif, setLatestAchNotif] = useState(null);
  const [profileAch, setProfileAch] = useState([]);
  const [toastMsg, setToastMsg] = useState("");

  useEffect(() => {
    saveLocal(state);
  }, [state]);

  useEffect(() => {
    if (!supabase) {
      return;
    }
    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (!cancelled) {
        setSession(s ?? null);
      }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s ?? null);
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase) return;
    seedPlayersIfEmpty(supabase);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase || !session?.user) {
        setMyPlayer(null);
        return;
      }
      const row = await fetchMyPlayer(supabase);
      if (cancelled) return;
      setMyPlayer(row ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) return;
      try {
        const remote = await fetchSeasonFromSupabase();
        if (cancelled || remote == null) return;
        setState((prev) => ({ ...prev, season: remote }));
      } catch (e) {
        console.warn("Supabase season load failed; using local cache", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) return;
      const row = await fetchLatestAchievementFeed(supabase);
      if (!cancelled) setLatestAchNotif(row);
    })();
    return () => {
      cancelled = true;
    };
  }, [state.season?.matches?.length]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase || !myPlayer?.id) {
        setProfileAch([]);
        return;
      }
      const rows = await fetchAchievementsForPlayer(supabase, myPlayer.id);
      if (!cancelled) setProfileAch(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [myPlayer?.id, session]);

  const update = (fn) => setState(prev => ({ ...prev, ...fn(prev) }));

  const { season, currentMatch, view, logStep, logData, playerProfileName } = state;
  const canEdit = myPlayer?.is_admin === true;
  const isGuest = !session?.user;
  const isAdminUser = myPlayer?.is_admin === true;
  const isPlayerUser = session?.user && myPlayer && !myPlayer.is_admin;

  const showToast = (msg) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(""), 2800);
  };

  const refreshMyPlayer = async () => {
    if (!supabase) return;
    const row = await fetchMyPlayer(supabase);
    setMyPlayer(row ?? null);
  };

  const closeAuthModal = () => {
    pendingAuthRef.current = null;
    setAuthModal({ open: false, subtitle: "" });
    setMagicLinkStep("email");
    setEmailInput("");
    setAuthErr("");
  };

  /** @param pending `{ kind, meta? }` stored in sessionStorage after user requests magic link (survives redirect). */
  const openAuthModal = (subtitle, pending = null) => {
    pendingAuthRef.current = pending;
    setAuthModal({ open: true, subtitle });
    setMagicLinkStep("email");
    setEmailInput("");
    setAuthErr("");
  };

  const openClaimSheetFromState = () => {
    if (!supabase) return;
    setState((prev) => {
      const squad = prev.season?.players || [];
      queueMicrotask(async () => {
        try {
          await syncSquadNamesToPlayers(supabase, squad);
          const rows = await fetchUnclaimedPlayersForSquad(supabase, squad);
          setUnclaimedList(rows);
          setClaimSheetOpen(true);
        } catch (e) {
          console.warn("openClaimSheet", e);
        }
      });
      return prev;
    });
  };

  const requestClaimProfile = () => {
    if (!supabase) return;
    if (!session?.user) {
      openAuthModal("Claim your profile", { kind: "claim" });
      return;
    }
    if (myPlayer) return;
    openClaimSheetFromState();
  };

  const runAfterAdminCheck = async () => {
    const row = await fetchMyPlayer(supabase);
    setMyPlayer(row ?? null);
    return row?.is_admin === true;
  };

  const beginNewMatch = () => {
    update(() => ({
      view: "new_match",
      currentMatch: {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        team1: { name: "Bibs", color: "#f59e0b", players: [] },
        team2: { name: "Non-Bibs", color: "#3b82f6", players: [] },
        score1: 0,
        score2: 0,
        events: [],
        motm: null,
        status: "setup",
      },
    }));
  };

  const requestLogMatch = () => {
    if (!supabase) return;
    if (isAdminUser) {
      beginNewMatch();
      return;
    }
    if (session?.user) {
      showToast("Only admins can log matches");
      return;
    }
    openAuthModal("Log a match", { kind: "log_match" });
  };

  const requestSquadAdmin = (action, pendingPayload) => {
    if (!supabase) return;
    if (isAdminUser) {
      action();
      return;
    }
    if (session?.user) {
      showToast("Only admins can change the squad");
      return;
    }
    openAuthModal("Manage squad", pendingPayload);
  };

  const requestResetSeason = () => {
    if (!supabase) return;
    if (isAdminUser) {
      if (!window.confirm("Reset entire season? This cannot be undone.")) return;
      const empty = { matches: [], players: [] };
      upsertSeasonToSupabase(empty).catch((e) => {
        console.warn("Supabase save failed; data kept in local storage", e);
      });
      update(() => ({ season: empty }));
      return;
    }
    if (session?.user) {
      showToast("Only admins can reset the season");
      return;
    }
    openAuthModal("Reset season", { kind: "reset_season" });
  };

  const handleSendMagicLink = async () => {
    if (!supabase) return;
    setAuthErr("");
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : undefined;
      await sendMagicLinkEmail(supabase, emailInput, origin);
      const pending = pendingAuthRef.current;
      if (pending?.kind) writePendingAuth(pending);
      setMagicLinkStep("sent");
    } catch (e) {
      setAuthErr(e?.message || "Could not send link");
    }
  };

  const handleLogout = async () => {
    if (!supabase) return;
    await signOut(supabase);
    try {
      sessionStorage.removeItem(WNF_PENDING_AUTH_KEY);
    } catch {
      /* ignore */
    }
    setMagicLinkStep("email");
    setEmailInput("");
    setAuthErr("");
    setMyPlayer(null);
    setUnclaimedList([]);
    closeAuthModal();
    update(() => ({
      view: "dashboard",
      currentMatch: null,
      logStep: null,
      logData: {},
      playerProfileName: null,
    }));
  };

  const handleClaimPlayer = async (playerId) => {
    if (!supabase) return;
    setClaimLoading(true);
    setAuthErr("");
    try {
      await claimPlayerRow(supabase, playerId);
      await refreshMyPlayer();
      setClaimSheetOpen(false);
    } catch (e) {
      setAuthErr(e?.message || "Could not claim profile");
    } finally {
      setClaimLoading(false);
    }
  };

  const handleAddSelfAndClaim = async () => {
    if (!supabase) return;
    const name = guestClaimName.trim();
    if (!name) return;
    setClaimLoading(true);
    setAuthErr("");
    try {
      await insertPlayerRow(supabase, name, true);
      setState((prev) => {
        const players = prev.season.players.includes(name)
          ? prev.season.players
          : [...prev.season.players, name];
        const nextSeason = { ...prev.season, players };
        upsertSeasonToSupabase(nextSeason).catch((err) => console.warn("Season sync failed", err));
        return { ...prev, season: nextSeason };
      });
      await refreshMyPlayer();
      setGuestClaimName("");
      setClaimSheetOpen(false);
    } catch (e) {
      setAuthErr(e?.message || "Could not add profile");
    } finally {
      setClaimLoading(false);
    }
  };

  const lastMatch = season.matches[season.matches.length - 1];
  const allGoals = useMemo(() => seasonGoals(season), [season]);
  const allOGs = useMemo(() => seasonOGs(season), [season]);
  const banter = useMemo(() => generateBanter(season), [season]);
  const allPlayers = useMemo(() => {
    const set = new Set();
    season.players.forEach(p => set.add(p));
    season.matches.forEach(m => {
      [...(m.team1?.players || []), ...(m.team2?.players || [])].forEach(p => set.add(p));
    });
    return [...set];
  }, [season]);

  // ── New match setup ──
  const startNewMatch = () => {
    if (!canEdit) return;
    beginNewMatch();
  };

  const saveCurrentMatch = () => {
    if (!currentMatch || !canEdit) return;
    setState((prev) => {
      if (!prev.currentMatch) return prev;
      const cm = prev.currentMatch;
      const idx = prev.season.matches.findIndex((m) => m.id === cm.id);
      const nextMatches =
        idx >= 0
          ? prev.season.matches.map((m, i) => (i === idx ? cm : m))
          : [...prev.season.matches, cm];
      const nextSeason = { ...prev.season, matches: nextMatches };
      const savedMatch = cm;
      const isAdmin = myPlayer?.is_admin === true;
      queueMicrotask(async () => {
        try {
          await upsertSeasonToSupabase(nextSeason);
          if (supabase && isAdmin) {
            await processAchievementsForSavedMatch(supabase, nextSeason, savedMatch);
            const feed = await fetchLatestAchievementFeed(supabase);
            setLatestAchNotif(feed);
          }
        } catch (e) {
          console.warn("Save / achievements failed", e);
        }
      });
      return {
        ...prev,
        season: nextSeason,
        currentMatch: null,
        view: "dashboard",
        logStep: null,
        logData: {},
      };
    });
  };

  const beginEditMatch = (m) => {
    if (!canEdit) return;
    let clone;
    try {
      clone = structuredClone(m);
    } catch {
      clone = JSON.parse(JSON.stringify(m));
    }
    update(() => ({
      view: "live",
      currentMatch: clone,
      logStep: null,
      logData: {},
    }));
  };

  const deleteSavedMatch = (m) => {
    if (!canEdit) return;
    if (
      !window.confirm(
        `Delete this match (${fmtDate(m.date)} — ${m.team1.name} vs ${m.team2.name})? This cannot be undone.`
      )
    ) {
      return;
    }
    const mid = m.id;
    setState((prev) => {
      const nextMatches = prev.season.matches.filter((x) => x.id !== mid);
      const nextSeason = { ...prev.season, matches: nextMatches };
      const isAdmin = myPlayer?.is_admin === true;
      queueMicrotask(async () => {
        try {
          if (supabase && isAdmin && mid) await deleteAchievementsForMatchIds(supabase, [mid]);
          await upsertSeasonToSupabase(nextSeason);
        } catch (e) {
          console.warn("Delete match / sync failed", e);
        }
      });
      return {
        ...prev,
        season: nextSeason,
        currentMatch: prev.currentMatch?.id === mid ? null : prev.currentMatch,
        view: prev.currentMatch?.id === mid ? "history" : prev.view,
        logStep: prev.currentMatch?.id === mid ? null : prev.logStep,
        logData: prev.currentMatch?.id === mid ? {} : prev.logData,
      };
    });
  };

  const requestClearMatches = () => {
    if (!supabase) return;
    if (isAdminUser) {
      if (
        !window.confirm(
          "Clear all logged matches? Your squad list is kept. This cannot be undone."
        )
      ) {
        return;
      }
      setState((prev) => {
        const ids = prev.season.matches.map((m) => m.id).filter(Boolean);
        const nextSeason = { ...prev.season, matches: [] };
        const isAdmin = myPlayer?.is_admin === true;
        queueMicrotask(async () => {
          try {
            if (supabase && isAdmin && ids.length) await deleteAchievementsForMatchIds(supabase, ids);
            await upsertSeasonToSupabase(nextSeason);
          } catch (e) {
            console.warn("Clear matches / sync failed", e);
          }
        });
        return {
          ...prev,
          season: nextSeason,
          currentMatch: null,
          view: "history",
          logStep: null,
          logData: {},
        };
      });
      return;
    }
    if (session?.user) {
      showToast("Only admins can clear match history");
      return;
    }
    openAuthModal("Clear match history", { kind: "clear_matches" });
  };

  // ── Event logging ──
  const startLogGoal = () => {
    if (!canEdit) return;
    update(() => ({ logStep: "pitch", logData: {} }));
  };

  const handlePitchClick = (e) => {
    if (!canEdit) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    update((prev) => ({
      logStep: "goalmouth",
      logData: { ...prev.logData, pitchX: x, pitchY: y },
    }));
  };

  const handleGoalTap = (goalX, goalY) => {
    if (!canEdit) return;
    let applied = false;
    setState((prev) => {
      if (prev.logStep !== "goalmouth" || prev.logData._showGoalDot) return prev;
      applied = true;
      return {
        ...prev,
        logData: { ...prev.logData, goalX, goalY, _showGoalDot: true },
      };
    });
    if (applied) {
      window.setTimeout(() => {
        setState((prev) => {
          if (prev.logStep !== "goalmouth") return prev;
          return {
            ...prev,
            logStep: "how",
            logData: { ...prev.logData, _showGoalDot: false },
          };
        });
      }, 200);
    }
  };

  const handleHowSelect = (how) => {
    if (!canEdit) return;
    const howOpt = HOW_OPTIONS.find(h => h.value === how);
    const gmQuip = buildGoalQuip(
      logData.goalX,
      logData.goalY,
      logData.pitchX,
      logData.pitchY
    );
    const isOG = how === "own_goal";
    const event = {
      id: crypto.randomUUID(),
      type: "goal",
      how,
      team: logData.team || 1,
      player: logData.player || null,
      goalX: logData.goalX,
      goalY: logData.goalY,
      pitchX: logData.pitchX,
      pitchY: logData.pitchY,
      quip: howOpt?.quip || "",
      gmQuip,
      time: currentMatch?.events?.length ? currentMatch.events.length + 1 : 1,
      isOG,
    };
    update(prev => {
      const cm = { ...prev.currentMatch };
      cm.events = [...(cm.events || []), event];
      if (isOG) {
        cm[`score${event.team === 1 ? 2 : 1}`] = (cm[`score${event.team === 1 ? 2 : 1}`] || 0) + 1;
      } else {
        cm[`score${event.team}`] = (cm[`score${event.team}`] || 0) + 1;
      }
      return { currentMatch: cm, logStep: null, logData: {}, view: "live" };
    });
  };

  const removeEvent = (id) => {
    if (!canEdit) return;
    update(prev => {
      const cm = { ...prev.currentMatch };
      const ev = cm.events.find(e => e.id === id);
      if (!ev) return {};
      cm.events = cm.events.filter(e => e.id !== id);
      // recount
      cm.score1 = cm.events.filter(e => (e.team === 1 && !e.isOG) || (e.team === 2 && e.isOG)).length;
      cm.score2 = cm.events.filter(e => (e.team === 2 && !e.isOG) || (e.team === 1 && e.isOG)).length;
      return { currentMatch: cm };
    });
  };

  // ── Views ──────────────────────────────────────────────────────────────────

  // DASHBOARD
  const Dashboard = () => {
    const miniStats = useMemo(() => {
      let goals = 0;
      let ogs = 0;
      season.matches.forEach((m) => {
        (m.events || []).forEach((ev) => {
          if (ev.type === "goal") {
            if (ev.isOG || ev.how === "own_goal") ogs += 1;
            else goals += 1;
          }
        });
      });
      return { goals, ogs, weeks: season.matches.length };
    }, [season.matches]);

    const feedName =
      latestAchNotif?.players?.name ||
      latestAchNotif?.players?.[0]?.name ||
      null;
    const feedType = latestAchNotif?.type;
    const feedShort =
      feedType && ACHIEVEMENT_META[feedType]
        ? ACHIEVEMENT_META[feedType].label.split(" — ")[0].trim()
        : feedType;

    return (
      <>
        <div className="topbar">
          <div className="topbar-logo">Wednesday FC ⚽</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="topbar-week">
              {isAdminUser ? "Admin" : isPlayerUser ? "Player" : isGuest ? "Guest" : "…"}
            </div>
            <div className="topbar-week" style={{ opacity: 0.85 }}>
              {season.matches.length > 0 ? `Week ${season.matches.length}` : "Season start"}
            </div>
            {isGuest && (
              <button
                type="button"
                className="topbar-link"
                onClick={() => openAuthModal("Sign in to Wednesday FC", null)}
              >
                Sign in
              </button>
            )}
            {session?.user && !myPlayer && (
              <button
                type="button"
                className="topbar-link"
                onClick={() => update(() => ({ view: "account" }))}
              >
                Account
              </button>
            )}
            {myPlayer && (
              <button
                type="button"
                className="avatar-btn"
                title="Your profile — right-click to log out"
                aria-label="Open your profile"
                onClick={() => update(() => ({ view: "profile" }))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (window.confirm("Log out?")) handleLogout();
                }}
              >
                {initials(myPlayer.name)}
              </button>
            )}
          </div>
        </div>

        {isPlayerUser && (
          <div className="card card-sm" style={{ marginBottom: 10, background: "#fafafa" }}>
            <div style={{ fontSize: 13, color: "#555" }}>View only — squad admins log matches and edit the squad.</div>
          </div>
        )}

        {latestAchNotif && feedName && feedShort && (
          <div className="ach-feed-card">
            <div className="ach-feed-emoji">🏆</div>
            <div className="ach-feed-text">
              <strong>{feedName}</strong> just earned <strong>{feedShort}</strong>
            </div>
          </div>
        )}

        {!lastMatch ? (
          <div className="card">
            <div className="no-matches">
              <div style={{ fontSize: 40, marginBottom: 12 }}>⚽</div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6, color: "#333" }}>No matches yet</div>
              <div>Get the lads together and log your first game.</div>
            </div>
            <button type="button" className="btn btn-primary" onClick={requestLogMatch}>
              Log first match
            </button>
            {!isAdminUser && (
              <p className="auth-hint" style={{ marginTop: 10 }}>
                {isGuest
                  ? "Sign in with an admin account to log matches — or browse as a guest."
                  : "Match logging is for squad admins only — you can still follow along here."}
              </p>
            )}
          </div>
        ) : (
          <div className="dashboard-grid">
            <div className="main-col">
              <div className="card match-card">
                <div className="section-label">Last result — {fmtDate(lastMatch.date)}</div>
                <div className="score-row">
                  <div className="score-team">
                    <div className="score-team-name">{lastMatch.team1.name}</div>
                    <div className="score-num">{lastMatch.score1}</div>
                  </div>
                  <div className="score-vs">—</div>
                  <div className="score-team">
                    <div className="score-team-name">{lastMatch.team2.name}</div>
                    <div className="score-num">{lastMatch.score2}</div>
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  {lastMatch.score1 === lastMatch.score2
                    ? <span className="draw-badge">Draw — honourable</span>
                    : <span className="winner-badge">
                        {lastMatch.score1 > lastMatch.score2 ? lastMatch.team1.name : lastMatch.team2.name} win
                      </span>}
                </div>
                <div className="match-footer">
                  <span>{fmtDate(lastMatch.date)}</span>
                  <span>
                    {[...(lastMatch.team1.players || []), ...(lastMatch.team2.players || [])].length} lads
                  </span>
                </div>
              </div>

              {lastMatch.events?.length > 0 && (
                <div className="card card-sm">
                  <div className="section-label">
                    How it happened <span className="pill">{lastMatch.events.length} goals</span>
                  </div>
                  {lastMatch.events.map((ev, i) => (
                    <div className="goal-item" key={ev.id}>
                      <div className="goal-icon">{ev.isOG ? "😬" : "⚽"}</div>
                      <div style={{ flex: 1 }}>
                        <div className="goal-name">
                          {ev.player || (ev.isOG ? "Someone (OG)" : "Unknown")}
                          {ev.isOG && <span style={{ color: "#e24b4a", fontWeight: 700 }}> (OG)</span>}
                        </div>
                        <div className="goal-desc">{ev.quip}{ev.gmQuip ? ` ${ev.gmQuip}` : ""}</div>
                      </div>
                      <div className="goal-time">Goal {i + 1}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="sidebar">
              {lastMatch.motm && (
                <div className="card card-sm">
                  <div className="section-label">Man of the match</div>
                  <div className="motm-card">
                    <div className="avatar avatar-lg avatar-amber">{initials(lastMatch.motm)}</div>
                    <div>
                      <div className="motm-name">{lastMatch.motm}</div>
                      <div className="motm-sub">The lads voted. Can't argue with it.</div>
                    </div>
                  </div>
                </div>
              )}

              <div className="dashboard-mini-stats">
                <div className="card card-sm dashboard-mini-stat">
                  <div className="dashboard-mini-stat-val">{miniStats.goals}</div>
                  <div className="dashboard-mini-stat-lbl">Goals this season</div>
                </div>
                <div className="card card-sm dashboard-mini-stat">
                  <div className="dashboard-mini-stat-val">{miniStats.weeks}</div>
                  <div className="dashboard-mini-stat-lbl">Weeks played</div>
                </div>
                <div className="card card-sm dashboard-mini-stat">
                  <div className="dashboard-mini-stat-val">{miniStats.ogs}</div>
                  <div className="dashboard-mini-stat-lbl">Own goals 🥚</div>
                </div>
              </div>

              {allGoals.length > 0 && (
                <div className="card card-sm">
                  <div className="section-label">Top scorer</div>
                  {allGoals.slice(0, 3).map(([name, n]) => (
                    <div
                      role="button"
                      tabIndex={0}
                      className={`stat-row stat-row--click${myPlayer?.name === name ? " stat-row--me" : ""}`}
                      key={name}
                      onClick={() => update(() => ({ view: "player_profile", playerProfileName: name }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          update(() => ({ view: "player_profile", playerProfileName: name }));
                        }
                      }}
                    >
                      <div className="avatar">{initials(name)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="stat-name">{name}</div>
                        <div className="bar-wrap">
                          <div className="bar" style={{ width: `${(n / allGoals[0][1]) * 100}%` }} />
                        </div>
                      </div>
                      <div className="stat-val">{n}</div>
                    </div>
                  ))}
                </div>
              )}

              {allGoals.length > 0 && (
                <div className="card card-sm">
                  <div className="section-label">Hall of shame</div>
                  {allOGs.length > 0 ? allOGs.slice(0, 3).map(([name, n]) => (
                    <div
                      role="button"
                      tabIndex={0}
                      className={`stat-row stat-row--click${myPlayer?.name === name ? " stat-row--me" : ""}`}
                      key={name}
                      onClick={() => update(() => ({ view: "player_profile", playerProfileName: name }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          update(() => ({ view: "player_profile", playerProfileName: name }));
                        }
                      }}
                    >
                      <div className="avatar avatar-og">{initials(name)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="stat-name">{name}</div>
                        <div className="bar-wrap">
                          <div className="bar bar-og" style={{ width: `${(n / allOGs[0][1]) * 100}%` }} />
                        </div>
                      </div>
                      <div className="stat-val">{n}</div>
                    </div>
                  )) : (
                    <div className="empty-state">No OGs yet.<br/>The season is young.</div>
                  )}
                  {allOGs.length > 0 && <div style={{ fontSize: 11, color: "#bbb", marginTop: 8 }}>Own goals only. You know who you are.</div>}
                </div>
              )}

              <div className="card card-sm">
                <div className="section-label">Season so far</div>
                {banter.map((line, i) => (
                  <div className="banter-item" key={i}>
                    <div className="banter-icon">{line.slice(0, 2)}</div>
                    <div>{line.slice(2).trim()}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <button type="button" className="btn btn-primary" onClick={requestLogMatch}>
          + Log this week&apos;s match
        </button>
      </>
    );
  };

  // NEW MATCH SETUP
  const NewMatch = () => {
    const [lineup, setLineup] = useState(() => ({
      team1: currentMatch?.team1 || { name: "Bibs", color: "#f59e0b", players: [] },
      team2: currentMatch?.team2 || { name: "Non-Bibs", color: "#3b82f6", players: [] },
    }));
    const [guestInp, setGuestInp] = useState("");
    const [guestOpen, setGuestOpen] = useState(false);
    const [poolSearch, setPoolSearch] = useState("");
    const [pickingPlayer, setPickingPlayer] = useState(null);
    const isEditingSaved = season.matches.some((m) => m.id === currentMatch?.id);

    const localTeam1 = lineup.team1;
    const localTeam2 = lineup.team2;

    const assignedSet = useMemo(
      () => new Set([...lineup.team1.players, ...lineup.team2.players]),
      [lineup.team1.players, lineup.team2.players]
    );
    const squadAvailable = useMemo(
      () => season.players.filter((p) => !assignedSet.has(p)),
      [season.players, assignedSet]
    );

    const filteredPool = useMemo(() => {
      const q = poolSearch.trim().toLowerCase();
      if (!q) return squadAvailable;
      return squadAvailable.filter((name) => name.toLowerCase().includes(q));
    }, [squadAvailable, poolSearch]);

    const squadAssignedCount = useMemo(
      () => season.players.filter((p) => assignedSet.has(p)).length,
      [season.players, assignedSet]
    );
    const squadTotal = season.players.length;

    const searchMatchesOnlyAssigned = useMemo(() => {
      const q = poolSearch.trim().toLowerCase();
      if (!q || filteredPool.length > 0) return false;
      return season.players.some((p) => p.toLowerCase().includes(q) && assignedSet.has(p));
    }, [poolSearch, filteredPool.length, season.players, assignedSet]);

    useEffect(() => {
      if (pickingPlayer && !squadAvailable.includes(pickingPlayer)) setPickingPlayer(null);
    }, [pickingPlayer, squadAvailable]);

    if (!canEdit) {
      return (
        <>
          <button type="button" className="back-btn" onClick={() => update(() => ({ view: "dashboard", currentMatch: null }))}>
            ← Back
          </button>
          <div className="card card-sm">
            <p style={{ fontSize: 14, color: "#555" }}>Only admins can set up or log matches.</p>
          </div>
        </>
      );
    }

    const addToTeam = (teamNum, rawName) => {
      const name = rawName.trim();
      if (!name) return;
      setLineup((prev) => {
        const all = [...prev.team1.players, ...prev.team2.players];
        if (all.includes(name)) return prev;
        const key = teamNum === 1 ? "team1" : "team2";
        return {
          ...prev,
          [key]: { ...prev[key], players: [...prev[key].players, name] },
        };
      });
    };

    const removeP = (teamNum, i) => {
      const key = teamNum === 1 ? "team1" : "team2";
      setLineup((prev) => ({
        ...prev,
        [key]: { ...prev[key], players: prev[key].players.filter((_, j) => j !== i) },
      }));
    };

    const randomise = () => {
      setPickingPlayer(null);
      setLineup((prev) => {
        const all = [...prev.team1.players, ...prev.team2.players];
        for (let i = all.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [all[i], all[j]] = [all[j], all[i]];
        }
        const half = Math.ceil(all.length / 2);
        return {
          team1: { ...prev.team1, players: all.slice(0, half) },
          team2: { ...prev.team2, players: all.slice(half) },
        };
      });
    };

    const proceed = () => {
      update(() => ({
        currentMatch: { ...currentMatch, team1: lineup.team1, team2: lineup.team2, status: "live" },
        view: "live",
      }));
    };

    const assignFromPicker = (teamNum, name) => {
      addToTeam(teamNum, name);
      setPickingPlayer(null);
    };

    const headerTitle = isEditingSaved ? "Edit teams" : "Set up teams";

    return (
      <>
        <button
          className="back-btn"
          onClick={() =>
            update(() => ({
              view: isEditingSaved ? "history" : "dashboard",
              currentMatch: null,
            }))
          }
        >
          ← Back
        </button>

        <div className="setup-header-row">
          <h1 className="setup-title">{headerTitle}</h1>
          <span className="setup-counter-pill">
            {squadTotal > 0
              ? `${squadAssignedCount} of ${squadTotal} assigned`
              : `${assignedSet.size} on teams`}
          </span>
        </div>

        <div className="teams-grid">
          {[1, 2].map((t) => {
            const team = t === 1 ? localTeam1 : localTeam2;
            const tk = t === 1 ? "team1" : "team2";
            const n = team.players.length;
            return (
              <div className="setup-team-card" key={t}>
                <div className="setup-team-head">
                  <div className="setup-team-title">
                    <div className="team-dot" style={{ background: team.color }} aria-hidden />
                    <input
                      className="setup-team-name-input"
                      value={team.name}
                      onChange={(e) =>
                        setLineup((prev) => ({
                          ...prev,
                          [tk]: { ...prev[tk], name: e.target.value },
                        }))
                      }
                      aria-label={`Team ${t} name`}
                    />
                  </div>
                  <span className="setup-team-count">{n} {n === 1 ? "player" : "players"}</span>
                </div>
                <div className="setup-team-avatars">
                  {n === 0 ? (
                    <div className="setup-team-empty" style={{ width: "100%" }}>
                      No one yet
                    </div>
                  ) : (
                    team.players.map((p, i) => (
                      <button
                        key={`${p}-${i}`}
                        type="button"
                        className="setup-avatar-btn"
                        style={{ background: team.color }}
                        title={`${p} — tap to unassign`}
                        aria-label={`Remove ${p} from ${team.name}`}
                        onClick={() => removeP(t, i)}
                      >
                        {initials(p)}
                      </button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="setup-pool-card">
          <input
            type="search"
            className="form-input setup-search"
            placeholder="Search players..."
            value={poolSearch}
            onChange={(e) => setPoolSearch(e.target.value)}
            aria-label="Search players"
          />
          <div className="setup-pool-label">Tap to assign</div>
          {season.players.length === 0 ? (
            <div className="setup-pool-hint">
              No one in your squad yet — add names in the Squad tab, or use <strong>+ Add guest</strong> below.
            </div>
          ) : squadAvailable.length === 0 ? (
            <div className="setup-pool-done">Everyone assigned!</div>
          ) : filteredPool.length === 0 ? (
            <div className="setup-pool-hint">
              {searchMatchesOnlyAssigned
                ? "All names matching your search are already on a team."
                : "No names match your search."}
            </div>
          ) : (
            <div className="setup-pool-chips">
              {filteredPool.map((name) => (
                <div className="setup-chip-wrap" key={name}>
                  <button
                    type="button"
                    className="setup-chip"
                    onClick={() => setPickingPlayer((prev) => (prev === name ? null : name))}
                    aria-expanded={pickingPlayer === name}
                  >
                    <span className="setup-chip-av" style={{ background: "#64748b" }}>
                      {initials(name)}
                    </span>
                    {name}
                  </button>
                  {pickingPlayer === name && (
                    <div className="setup-picker">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => assignFromPicker(1, name)}
                      >
                        {localTeam1.name}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => assignFromPicker(2, name)}
                      >
                        {localTeam2.name}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <button type="button" className="setup-guest-link" onClick={() => setGuestOpen((o) => !o)}>
            + Add guest
          </button>
          {guestOpen && (
            <div className="setup-guest-panel">
              <div className="guest-add-row">
                <input
                  className="form-input"
                  style={{ padding: "8px 12px", fontSize: 13 }}
                  placeholder="Guest name..."
                  value={guestInp}
                  onChange={(e) => setGuestInp(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addToTeam(1, guestInp);
                      setGuestInp("");
                    }
                  }}
                />
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { addToTeam(1, guestInp); setGuestInp(""); }}>
                  → {localTeam1.name}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { addToTeam(2, guestInp); setGuestInp(""); }}>
                  → {localTeam2.name}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="setup-footer-btns">
          <button type="button" className="btn btn-ghost" onClick={randomise}>
            🎲 Randomise
          </button>
          <button type="button" className="btn btn-primary" onClick={proceed}>
            Kick off →
          </button>
        </div>
      </>
    );
  };

  const addSquadPlayer = (raw) => {
    const name = raw.trim();
    if (!name) return;
    setState((prev) => {
      if (prev.season.players.includes(name)) return prev;
      const nextSeason = { ...prev.season, players: [...prev.season.players, name] };
      upsertSeasonToSupabase(nextSeason).catch((e) => {
        console.warn("Supabase save failed; squad kept in local storage", e);
      });
      return { ...prev, season: nextSeason };
    });
  };

  const removeSquadPlayer = (name) => {
    setState((prev) => {
      const nextSeason = { ...prev.season, players: prev.season.players.filter((p) => p !== name) };
      upsertSeasonToSupabase(nextSeason).catch((e) => {
        console.warn("Supabase save failed; squad kept in local storage", e);
      });
      return { ...prev, season: nextSeason };
    });
  };

  const Squad = () => {
    const [addInp, setAddInp] = useState("");
    return (
      <>
        <div className="topbar">
          <div className="topbar-logo">Squad 👥</div>
          <div className="topbar-week">Roster</div>
        </div>
        <div className="card card-sm">
          <div className="section-label">Add player</div>
          {isAdminUser ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="form-input"
                style={{ flex: 1 }}
                placeholder="Name..."
                value={addInp}
                onChange={(e) => setAddInp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    addSquadPlayer(addInp);
                    setAddInp("");
                  }
                }}
              />
              <button type="button" className="btn btn-primary btn-sm" style={{ width: "auto" }} onClick={() => { addSquadPlayer(addInp); setAddInp(""); }}>
                Add
              </button>
            </div>
          ) : isGuest ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="form-input"
                style={{ flex: 1 }}
                placeholder="Name..."
                value={addInp}
                onChange={(e) => setAddInp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const nm = addInp.trim();
                    if (!nm) return;
                    requestSquadAdmin(
                      () => {
                        addSquadPlayer(addInp);
                        setAddInp("");
                      },
                      { kind: "squad_add", meta: { name: nm } }
                    );
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ width: "auto" }}
                onClick={() => {
                  const nm = addInp.trim();
                  if (!nm) return;
                  requestSquadAdmin(
                    () => {
                      addSquadPlayer(addInp);
                      setAddInp("");
                    },
                    { kind: "squad_add", meta: { name: nm } }
                  );
                }}
              >
                Add
              </button>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: "#888" }}>Only admins can change the squad.</p>
          )}
        </div>
        <div className="card card-sm">
          <div className="section-label">Saved players</div>
          {season.players.length === 0 ? (
            <div className="empty-state">No players saved yet.</div>
          ) : (
            <div className="player-list">
              {season.players.map((name) => (
                <div className="player-tag" key={name}>
                  <span>{name}</span>
                  {isAdminUser && (
                    <button type="button" onClick={() => removeSquadPlayer(name)} aria-label={`Remove ${name}`}>
                      ×
                    </button>
                  )}
                  {isGuest && (
                    <button
                      type="button"
                      onClick={() =>
                        requestSquadAdmin(() => removeSquadPlayer(name), {
                          kind: "squad_remove",
                          meta: { name },
                        })
                      }
                      aria-label={`Remove ${name}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    );
  };

  // LIVE MATCH
  const LiveMatch = () => {
    const cm = currentMatch;
    if (!cm) return null;

    const isEditingSaved = season.matches.some((m) => m.id === cm.id);

    const setMOTM = (name) => {
      if (!canEdit) return;
      update((prev) => ({
        currentMatch: { ...prev.currentMatch, motm: name },
      }));
    };

    const allMatchPlayers = [...(cm.team1.players || []), ...(cm.team2.players || [])];

    return (
      <>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <button className="back-btn" onClick={() => update(() => ({ view: canEdit ? "new_match" : "dashboard", currentMatch: canEdit ? cm : null }))}>
            ← {canEdit ? "Setup" : "Back"}
          </button>
          <span style={{ fontSize: 12, color: "#999", fontWeight: 600 }}>Live</span>
        </div>

        {!canEdit && (
          <div className="card card-sm" style={{ marginBottom: 10, background: "#fafafa" }}>
            <div style={{ fontSize: 12, color: "#666" }}>View only — admins log goals and save matches.</div>
          </div>
        )}

        {canEdit && isEditingSaved && (
          <div className="card card-sm" style={{ marginBottom: 10, background: "#f0f7ff", borderColor: "#cfe8ff" }}>
            <div style={{ fontSize: 13, color: "#333", lineHeight: 1.45 }}>
              Editing a saved match — adjust scores, goals, or MOTM, then <strong>Save</strong> to update. Use <strong>Discard</strong> to leave the stored match unchanged.
            </div>
          </div>
        )}

        {/* Live score */}
        <div className="card">
          <div className="score-row" style={{ marginBottom: 8 }}>
            <div className="score-team">
              <div className="score-team-name">{cm.team1.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {canEdit && (
                  <button type="button" className="score-adj-btn" onClick={() => update((prev) => {
                    const cm2 = { ...prev.currentMatch };
                    cm2.score1 = Math.max(0, cm2.score1 - 1);
                    return { currentMatch: cm2 };
                  })}>−</button>
                )}
                <div className="live-score">{cm.score1}</div>
                {canEdit && (
                  <button type="button" className="score-adj-btn" onClick={() => update((prev) => {
                    const cm2 = { ...prev.currentMatch };
                    cm2.score1 = cm2.score1 + 1;
                    return { currentMatch: cm2 };
                  })}>+</button>
                )}
              </div>
            </div>
            <div className="score-vs">—</div>
            <div className="score-team">
              <div className="score-team-name">{cm.team2.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {canEdit && (
                  <button type="button" className="score-adj-btn" onClick={() => update((prev) => {
                    const cm2 = { ...prev.currentMatch };
                    cm2.score2 = Math.max(0, cm2.score2 - 1);
                    return { currentMatch: cm2 };
                  })}>−</button>
                )}
                <div className="live-score">{cm.score2}</div>
                {canEdit && (
                  <button type="button" className="score-adj-btn" onClick={() => update((prev) => {
                    const cm2 = { ...prev.currentMatch };
                    cm2.score2 = cm2.score2 + 1;
                    return { currentMatch: cm2 };
                  })}>+</button>
                )}
              </div>
            </div>
          </div>

          {canEdit && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 8 }}>
              Log a goal for...
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[1, 2].map((t) => (
                <button
                  key={t}
                  type="button"
                  className="btn btn-ghost"
                  style={{ flex: 1, background: logData.team === t ? "#111" : undefined, color: logData.team === t ? "#fff" : undefined }}
                  onClick={() => {
                    update(() => ({ logData: { ...logData, team: t }, logStep: "player" }));
                  }}
                >
                  {t === 1 ? cm.team1.name : cm.team2.name}
                </button>
              ))}
            </div>
          </div>
          )}
        </div>

        {/* Player select step */}
        {canEdit && logStep === "player" && (
          <div className="card card-sm">
            <div className="section-label">Who scored?</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {(logData.team === 1 ? cm.team1.players : cm.team2.players).map(p => (
                <button
                  key={p}
                  className="how-btn"
                  onClick={() => {
                    update(() => ({ logData: { ...logData, player: p }, logStep: "pitch" }));
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div className="avatar" style={{ width: 24, height: 24, fontSize: 9 }}>{initials(p)}</div>
                    {p}
                  </div>
                </button>
              ))}
              <button className="how-btn" style={{ color: "#bbb" }}
                onClick={() => update(() => ({ logData: { ...logData, player: null }, logStep: "pitch" }))}>
                Unknown
              </button>
            </div>
          </div>
        )}

        {/* Pitch tap step */}
        {canEdit && logStep === "pitch" && (
          <div className="card card-sm">
            <div className="section-label">Where on the pitch?</div>
            <PitchSVG events={cm.events} onTap={handlePitchClick} />
            <div className="pitch-tap-hint">Tap where the shot came from</div>
          </div>
        )}

        {/* Goalmouth step */}
        {canEdit && logStep === "goalmouth" && (
          <div className="card card-sm">
            <div className="section-label">Where did it go in?</div>
            <GoalmouthSVG
              dot={
                logData._showGoalDot && logData.goalX != null && logData.goalY != null
                  ? { x: logData.goalX, y: logData.goalY }
                  : null
              }
              onGoalTap={handleGoalTap}
            />
            <div className="goalmouth-hint">Tap where it went in</div>
          </div>
        )}

        {/* How scored step */}
        {canEdit && logStep === "how" && (
          <div className="card card-sm">
            <div className="section-label">How was it scored?</div>
            <div className="how-grid">
              {HOW_OPTIONS.map(h => (
                <button key={h.value} className="how-btn" onClick={() => handleHowSelect(h.value)}>
                  {h.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Goal feed */}
        {cm.events?.length > 0 && (
          <div className="card card-sm">
            <div className="section-label">Goals <span className="pill">{cm.events.length}</span></div>
            {[...cm.events].reverse().map((ev, i) => (
              <div className="goal-item" key={ev.id}>
                <div className="goal-icon">{ev.isOG ? "😬" : "⚽"}</div>
                <div style={{ flex: 1 }}>
                  <div className="goal-name">
                    {ev.player || "Unknown"}
                    {ev.isOG && <span style={{ color: "#e24b4a" }}> (OG)</span>}
                  </div>
                  <div className="goal-desc">{ev.quip}</div>
                </div>
                {canEdit && <button type="button" className="goal-del" onClick={() => removeEvent(ev.id)}>×</button>}
              </div>
            ))}
          </div>
        )}

        {/* MOTM */}
        {allMatchPlayers.length > 0 && (
          <div className="card card-sm">
            <div className="section-label">Man of the match</div>
            {canEdit ? (
              <div className="motm-select">
                {allMatchPlayers.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`motm-option ${cm.motm === p ? "selected" : ""}`}
                    onClick={() => setMOTM(p)}
                  >
                    <div className="avatar" style={{ width: 24, height: 24, fontSize: 9, flexShrink: 0 }}>{initials(p)}</div>
                    {p}
                  </button>
                ))}
              </div>
            ) : (
              <div className="motm-card">
                {cm.motm ? (
                  <>
                    <div className="avatar avatar-lg avatar-amber">{initials(cm.motm)}</div>
                    <div><div className="motm-name">{cm.motm}</div></div>
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: "#999" }}>Not picked yet</div>
                )}
              </div>
            )}
          </div>
        )}

        {canEdit && (
          <button type="button" className="btn btn-green" onClick={saveCurrentMatch}>
            {isEditingSaved ? "✓ Save changes" : "✓ Save match"}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() =>
            update(() => ({
              view: isEditingSaved ? "history" : "dashboard",
              currentMatch: null,
              logStep: null,
              logData: {},
            }))
          }
        >
          {canEdit ? "Discard" : "Close"}
        </button>
      </>
    );
  };

  // HISTORY
  const History = () => (
    <>
      <div style={{ fontWeight: 900, fontSize: 22, marginBottom: 16 }}>All matches</div>
      {season.matches.length === 0 ? (
        <div className="card"><div className="no-matches">No matches logged yet.</div></div>
      ) : (
        <div className="card card-sm">
          {[...season.matches].reverse().map((m) => {
            const winner = m.score1 > m.score2 ? m.team1.name : m.score2 > m.score1 ? m.team2.name : null;
            return (
              <div className="match-history-item" key={m.id}>
                <div className="mhi-block">
                  <div className="mhi-score">{m.score1} — {m.score2}</div>
                  <div className="mhi-teams">{m.team1.name} vs {m.team2.name}</div>
                </div>
                <div className="mhi-block" style={{ textAlign: "right" }}>
                  <div className="mhi-date">{fmtDate(m.date)}</div>
                  {winner
                    ? <div style={{ fontSize: 11, color: "#27500a", fontWeight: 700, marginTop: 2 }}>{winner} win</div>
                    : <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Draw</div>}
                </div>
                {canEdit && (
                  <div className="match-history-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => beginEditMatch(m)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => deleteSavedMatch(m)}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
        {(isAdminUser || isGuest) && season.matches.length > 0 && (
          <button type="button" className="btn btn-danger btn-sm" onClick={requestClearMatches}>
            Clear all matches
          </button>
        )}
        {(isAdminUser || isGuest) && (
          <button type="button" className="btn btn-danger btn-sm" onClick={requestResetSeason}>
            Reset season
          </button>
        )}
      </div>
    </>
  );

  const Account = () => (
    <>
      <button type="button" className="back-btn" onClick={() => update(() => ({ view: "dashboard" }))}>
        ← Back
      </button>
      <div className="topbar">
        <div className="topbar-logo">Account</div>
        <div className="topbar-week">Signed in</div>
      </div>
      <div className="card card-sm">
        <p style={{ fontSize: 14, color: "#555", marginBottom: 14, lineHeight: 1.5 }}>
          Link your account to a squad name to unlock personal stats and achievements.
        </p>
        <button type="button" className="btn btn-primary" onClick={requestClaimProfile}>
          Claim your profile
        </button>
      </div>
      <p style={{ textAlign: "center", marginTop: 16 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
          Log out
        </button>
      </p>
    </>
  );

  const PlayerProfileView = () => {
    const name = playerProfileName || "";
    const [row, setRow] = useState(null);
    const [pAch, setPAch] = useState([]);
    const stats = useMemo(() => playerSeasonStats(season, name), [season, name]);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        if (!name || !supabase) {
          setRow(null);
          setPAch([]);
          return;
        }
        const p = await fetchPlayerByName(supabase, name);
        if (cancelled) return;
        setRow(p);
        if (p?.id) {
          const a = await fetchAchievementsForPlayer(supabase, p.id);
          if (!cancelled) setPAch(a);
        } else {
          setPAch([]);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [name]);

    const isMe = myPlayer && row && myPlayer.id === row.id;
    const showClaimCta = Boolean(row && row.claimed_by == null && !myPlayer);

    const claimThisPlayer = () => {
      if (!row?.id) return;
      if (!session?.user) {
        openAuthModal("Claim your profile", { kind: "claim_player", meta: { playerId: row.id } });
        return;
      }
      if (myPlayer) {
        showToast("You're already linked to a profile.");
        return;
      }
      (async () => {
        try {
          await claimPlayerRow(supabase, row.id);
          await refreshMyPlayer();
          update(() => ({ view: "profile", playerProfileName: null }));
        } catch (e) {
          showToast(e?.message || "Could not claim profile");
        }
      })();
    };

    return (
      <>
        <button
          type="button"
          className="back-btn"
          onClick={() => update(() => ({ view: "dashboard", playerProfileName: null }))}
        >
          ← Back
        </button>
        <div className="topbar">
          <div className="topbar-logo">{name || "Player"}</div>
          <div className="topbar-week">Profile</div>
        </div>
        <div className="card card-sm">
          <div className="section-label">Season stats</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, textAlign: "center" }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 900 }}>{stats.goals}</div>
              <div style={{ fontSize: 11, color: "#888" }}>Goals</div>
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 900 }}>{stats.ogs}</div>
              <div style={{ fontSize: 11, color: "#888" }}>Own goals</div>
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 900 }}>{stats.apps}</div>
              <div style={{ fontSize: 11, color: "#888" }}>Appearances</div>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="section-label">Achievements</div>
          {pAch.length === 0 ? (
            <p style={{ fontSize: 14, color: "#999" }}>None yet.</p>
          ) : (
            <div className="profile-badges" role="list">
              {pAch.map((ar) => {
                const meta = ACHIEVEMENT_META[ar.type];
                return (
                  <span
                    key={ar.id}
                    className="ach-badge"
                    role="listitem"
                    title={meta?.label || ar.type}
                    aria-label={meta?.label || ar.type}
                  >
                    {meta?.emoji || "🏅"}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {isMe && (
          <p style={{ fontSize: 13, color: "#666", textAlign: "center" }}>This is you — full details in Profile.</p>
        )}
        {showClaimCta && (
          <button type="button" className="btn btn-primary" onClick={claimThisPlayer}>
            Claim this profile
          </button>
        )}
        {row?.claimed_by != null && !isMe && (
          <p style={{ fontSize: 13, color: "#888", textAlign: "center" }}>This name is already claimed.</p>
        )}
      </>
    );
  };

  const Profile = () => {
    if (!myPlayer) {
      return (
        <>
          <button type="button" className="back-btn" onClick={() => update(() => ({ view: "dashboard" }))}>
            ← Back
          </button>
          <div className="card card-sm">
            <p style={{ fontSize: 14, color: "#555" }}>Claim a squad profile to see your page here.</p>
            <button type="button" className="btn btn-primary" style={{ marginTop: 10 }} onClick={requestClaimProfile}>
              Claim your profile
            </button>
          </div>
        </>
      );
    }
    return (
      <>
        <button type="button" className="back-btn" onClick={() => update(() => ({ view: "dashboard" }))}>
          ← Back
        </button>
        <div className="topbar">
          <div className="topbar-logo">Profile</div>
          <div className="topbar-week">{myPlayer?.is_admin ? "Admin" : "Player"}</div>
        </div>
        <div className="card">
          <div className="section-label">Name</div>
          <div style={{ fontSize: 22, fontWeight: 900 }}>{myPlayer?.name}</div>
          <div className="section-label" style={{ marginTop: 20 }}>Achievements</div>
          {profileAch.length === 0 ? (
            <p style={{ fontSize: 14, color: "#999" }}>None yet — keep turning up on Wednesdays.</p>
          ) : (
            <div className="profile-badges" role="list">
              {profileAch.map((achRow) => {
                const meta = ACHIEVEMENT_META[achRow.type];
                return (
                  <span
                    key={achRow.id}
                    className="ach-badge"
                    role="listitem"
                    title={meta?.label || achRow.type}
                    aria-label={meta?.label || achRow.type}
                  >
                    {meta?.emoji || "🏅"}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <p style={{ textAlign: "center", marginTop: 16 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
            Log out
          </button>
        </p>
      </>
    );
  };

  // PITCH SVG component
  const PitchSVG = ({ events = [], onTap }) => (
    <svg
      viewBox="0 0 100 65" className="pitch-svg"
      onClick={onTap}
      style={{ background: "#1e8a42" }}
    >
      {/* Stripes */}
      {[0,1,2,3,4].map(i => (
        <rect key={i} x={i*20} y={0} width={10} height={65} fill="#1a7a3c" opacity={0.5} />
      ))}
      {/* Pitch border */}
      <rect x={2} y={2} width={96} height={61} fill="none" stroke="rgba(255,255,255,0.65)" strokeWidth={0.6} />
      {/* Centre */}
      <line x1={50} y1={2} x2={50} y2={63} stroke="rgba(255,255,255,0.6)" strokeWidth={0.5} />
      <circle cx={50} cy={32.5} r={9} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={0.5} />
      <circle cx={50} cy={32.5} r={0.8} fill="rgba(255,255,255,0.6)" />
      {/* Left box */}
      <rect x={2} y={18} width={16} height={29} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={0.5} />
      <rect x={2} y={24} width={6} height={17} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={0.4} />
      <circle cx={14} cy={32.5} r={0.6} fill="rgba(255,255,255,0.5)" />
      <rect x={0} y={27} width={2} height={11} fill="rgba(255,255,255,0.2)" stroke="rgba(255,255,255,0.4)" strokeWidth={0.3} />
      {/* Right box */}
      <rect x={82} y={18} width={16} height={29} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={0.5} />
      <rect x={92} y={24} width={6} height={17} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={0.4} />
      <circle cx={86} cy={32.5} r={0.6} fill="rgba(255,255,255,0.5)" />
      <rect x={98} y={27} width={2} height={11} fill="rgba(255,255,255,0.2)" stroke="rgba(255,255,255,0.4)" strokeWidth={0.3} />
      {/* Shot markers */}
      {events.map(ev => (
        <g key={ev.id} className="shot-marker">
          <circle
            cx={ev.pitchX || 50} cy={ev.pitchY || 32}
            r={2.5}
            fill={ev.isOG ? "#e24b4a" : "#f0c040"}
            stroke="#000" strokeWidth={0.4}
            opacity={0.9}
          />
        </g>
      ))}
    </svg>
  );

  /** After magic-link redirect, resume the action the user started before sign-in. */
  useEffect(() => {
    if (!supabase || !session?.user) return;
    const pending = readAndClearPendingAuth();
    if (!pending?.kind) return;

    queueMicrotask(async () => {
      const row = await fetchMyPlayer(supabase);
      setMyPlayer(row ?? null);

      const toast = (msg) => {
        setToastMsg(msg);
        window.setTimeout(() => setToastMsg(""), 2800);
      };

      switch (pending.kind) {
        case "claim":
          openClaimSheetFromState();
          break;
        case "claim_player": {
          const pid = pending.meta?.playerId;
          if (!pid) break;
          try {
            await claimPlayerRow(supabase, pid);
            await refreshMyPlayer();
            update(() => ({ view: "profile", playerProfileName: null }));
          } catch (e) {
            toast(e?.message || "Could not claim profile");
          }
          break;
        }
        case "log_match":
          if (row?.is_admin) queueMicrotask(() => beginNewMatch());
          else toast("Only admins can log matches");
          break;
        case "reset_season":
          if (!row?.is_admin) {
            toast("Only admins can reset the season");
            break;
          }
          queueMicrotask(() => {
            if (!window.confirm("Reset entire season? This cannot be undone.")) return;
            const empty = { matches: [], players: [] };
            upsertSeasonToSupabase(empty).catch((e) => {
              console.warn("Supabase save failed; data kept in local storage", e);
            });
            update(() => ({ season: empty }));
          });
          break;
        case "clear_matches":
          if (!row?.is_admin) {
            toast("Only admins can clear match history");
            break;
          }
          queueMicrotask(() => {
            if (
              !window.confirm(
                "Clear all logged matches? Your squad list is kept. This cannot be undone."
              )
            ) {
              return;
            }
            setState((prev) => {
              const ids = prev.season.matches.map((m) => m.id).filter(Boolean);
              const nextSeason = { ...prev.season, matches: [] };
              queueMicrotask(async () => {
                try {
                  if (supabase && ids.length) await deleteAchievementsForMatchIds(supabase, ids);
                  await upsertSeasonToSupabase(nextSeason);
                } catch (e) {
                  console.warn("Clear matches / sync failed", e);
                }
              });
              return {
                ...prev,
                season: nextSeason,
                currentMatch: null,
                view: "history",
                logStep: null,
                logData: {},
              };
            });
          });
          break;
        case "squad_add": {
          const nm = (pending.meta?.name || "").trim();
          if (!row?.is_admin) {
            toast("Only admins can change the squad");
            break;
          }
          if (!nm) break;
          queueMicrotask(() => {
            setState((prev) => {
              if (prev.season.players.includes(nm)) return prev;
              const nextSeason = { ...prev.season, players: [...prev.season.players, nm] };
              upsertSeasonToSupabase(nextSeason).catch((err) => {
                console.warn("Supabase save failed; squad kept in local storage", err);
              });
              return { ...prev, season: nextSeason };
            });
          });
          break;
        }
        case "squad_remove": {
          const nm = pending.meta?.name;
          if (!row?.is_admin) {
            toast("Only admins can change the squad");
            break;
          }
          if (!nm) break;
          queueMicrotask(() => {
            setState((prev) => {
              const nextSeason = { ...prev.season, players: prev.season.players.filter((p) => p !== nm) };
              upsertSeasonToSupabase(nextSeason).catch((err) => {
                console.warn("Supabase save failed; squad kept in local storage", err);
              });
              return { ...prev, season: nextSeason };
            });
          });
          break;
        }
        default:
          break;
      }
    });
    // Intentionally only when the signed-in user changes (post magic-link redirect).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resume uses latest handlers from this render
  }, [session?.user?.id]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (!supabase) {
    return (
      <>
        <style>{CSS}</style>
        <div className="app auth-screen">
          <div className="auth-title">Wednesday FC</div>
          <div className="auth-card">
            <p style={{ fontSize: 14, color: "#555", lineHeight: 1.6 }}>
              Set <code style={{ fontSize: 13 }}>VITE_SUPABASE_URL</code> and{" "}
              <code style={{ fontSize: 13 }}>VITE_SUPABASE_ANON_KEY</code> in{" "}
              <code style={{ fontSize: 13 }}>.env</code>, then restart the dev server.
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      {toastMsg ? <div className="toast-mini">{toastMsg}</div> : null}
      <div className="app">
        {view === "dashboard" && <Dashboard />}
        {view === "new_match" && <NewMatch />}
        {view === "live" && <LiveMatch />}
        {view === "squad" && <Squad />}
        {view === "history" && <History />}
        {view === "profile" && <Profile />}
        {view === "account" && <Account />}
        {view === "player_profile" && playerProfileName && <PlayerProfileView />}
      </div>

      {authModal.open && (
        <div
          className="auth-sheet-backdrop auth-sheet-backdrop--center"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAuthModal();
          }}
        >
          <div className="auth-sheet auth-sheet-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auth-sheet-head">
              <div>
                <div className="auth-sheet-title">Sign in to continue</div>
                {authModal.subtitle ? <div className="auth-sheet-sub">{authModal.subtitle}</div> : null}
              </div>
              <button type="button" className="auth-sheet-close" aria-label="Close" onClick={closeAuthModal}>
                ×
              </button>
            </div>
            {magicLinkStep === "email" ? (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="wnf-email-modal">
                    Email address
                  </label>
                  <input
                    id="wnf-email-modal"
                    className="form-input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSendMagicLink();
                    }}
                    placeholder="your@email.com"
                  />
                </div>
                <button type="button" className="btn btn-primary" onClick={handleSendMagicLink}>
                  Send link
                </button>
              </>
            ) : (
              <>
                <p style={{ fontSize: 15, fontWeight: 700, color: "#111", margin: "0 0 8px", lineHeight: 1.4 }}>
                  Check your inbox — we&apos;ve sent you a sign in link
                </p>
                <p style={{ fontSize: 14, color: "#555", margin: 0, lineHeight: 1.5 }}>
                  We&apos;ve sent a link to your inbox. Click it to sign in.
                </p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ marginTop: 16 }}
                  onClick={() => {
                    setMagicLinkStep("email");
                    setAuthErr("");
                  }}
                >
                  Use a different email
                </button>
              </>
            )}
            {authErr ? <div className="auth-err">{authErr}</div> : null}
            {magicLinkStep === "email" ? (
              <p className="auth-hint">We&apos;ll email you a one-time link. No password.</p>
            ) : null}
          </div>
        </div>
      )}

      {claimSheetOpen && session?.user && !myPlayer && (
        <div
          className="auth-sheet-backdrop auth-sheet-backdrop--center"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setClaimSheetOpen(false);
          }}
        >
          <div className="auth-sheet auth-sheet-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auth-sheet-head">
              <div>
                <div className="auth-sheet-title">Claim your profile</div>
                <div className="auth-sheet-sub">Tap your name if you&apos;re on the squad, or add yourself below.</div>
              </div>
              <button
                type="button"
                className="auth-sheet-close"
                aria-label="Close"
                onClick={() => setClaimSheetOpen(false)}
              >
                ×
              </button>
            </div>
            {unclaimedList.length === 0 ? (
              <p style={{ fontSize: 14, color: "#666", marginBottom: 12 }}>
                No unclaimed squad names yet. Add yourself below, or ask an admin to add you to the squad first.
              </p>
            ) : (
              <>
                <div className="section-label">Pick your name</div>
                <div className="claim-list">
                  {unclaimedList.map((pr) => (
                    <button
                      key={pr.id}
                      type="button"
                      className="claim-row"
                      disabled={claimLoading}
                      onClick={() => handleClaimPlayer(pr.id)}
                    >
                      {pr.name}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="section-label" style={{ marginTop: 20 }}>
              Not listed?
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                className="form-input"
                style={{ flex: 1, minWidth: 160 }}
                placeholder="Your name"
                value={guestClaimName}
                onChange={(e) => setGuestClaimName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddSelfAndClaim();
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: "auto" }}
                disabled={claimLoading}
                onClick={handleAddSelfAndClaim}
              >
                Add &amp; claim
              </button>
            </div>
            {authErr ? <div className="auth-err">{authErr}</div> : null}
          </div>
        </div>
      )}

      {!logStep && (
        <nav className="nav">
          <button
            type="button"
            className={`nav-btn ${view === "dashboard" ? "active" : ""}`}
            onClick={() => update(() => ({ view: "dashboard" }))}
          >
            <span className="nav-icon">🏠</span>Home
          </button>
          <button
            type="button"
            className={`nav-btn ${view === "live" || view === "new_match" ? "active" : ""}`}
            onClick={() => {
              if (currentMatch) update(() => ({ view: "live" }));
              else requestLogMatch();
            }}
          >
            <span className="nav-icon">⚽</span>Match
          </button>
          <button
            type="button"
            className={`nav-btn ${view === "squad" ? "active" : ""}`}
            onClick={() => update(() => ({ view: "squad" }))}
          >
            <span className="nav-icon">👤</span>Squad
          </button>
          <button
            type="button"
            className={`nav-btn ${view === "history" ? "active" : ""}`}
            onClick={() => update(() => ({ view: "history" }))}
          >
            <span className="nav-icon">📋</span>History
          </button>
        </nav>
      )}
    </>
  );
}
