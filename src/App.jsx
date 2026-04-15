import { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabase.js";

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

function normalizeSeason(s) {
  if (!s || typeof s !== "object") return { matches: [], players: [] };
  return {
    matches: Array.isArray(s.matches) ? s.matches : [],
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

const GOALMOUTH = [
  { id: "tl", label: "Top left",     x: "15%",  y: "18%" },
  { id: "tc", label: "Top centre",   x: "50%",  y: "12%" },
  { id: "tr", label: "Top right",    x: "85%",  y: "18%" },
  { id: "ml", label: "Mid left",     x: "15%",  y: "50%" },
  { id: "mc", label: "Straight at",  x: "50%",  y: "50%" },
  { id: "mr", label: "Mid right",    x: "85%",  y: "50%" },
  { id: "bl", label: "Bottom left",  x: "15%",  y: "82%" },
  { id: "bc", label: "Bottom centre",x: "50%",  y: "82%" },
  { id: "br", label: "Bottom right", x: "85%",  y: "82%" },
];

const GOAL_QUIPS = {
  tl: "Top left. Unsaveable.",
  tc: "Right in the top bin.",
  tr: "Top right. Keeper had no chance.",
  ml: "Mid left. Placed.",
  mc: "Straight at the keeper. Got lucky.",
  mr: "Mid right. Clean finish.",
  bl: "Bottom left. Rolled in.",
  bc: "Low and central. Under him.",
  br: "Bottom right. Slid in.",
};

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
};

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

// ── Styles (injected) ─────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Figtree',sans-serif;background:#f5f5f0;min-height:100vh;color:#111}
.app{max-width:480px;margin:0 auto;padding:16px;padding-bottom:80px;display:flex;flex-direction:column;gap:12px}
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
.pitch-svg{width:100%;border-radius:12px;cursor:crosshair;display:block}
.pitch-tap-hint{font-size:12px;color:#999;text-align:center;margin-top:8px}
.how-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.how-btn{padding:12px;border-radius:12px;border:1px solid #e8e8e8;background:#fff;font-family:'Figtree',sans-serif;font-size:13px;font-weight:600;cursor:pointer;text-align:left;transition:border-color 0.15s}
.how-btn:hover{border-color:#111;background:#f9f9f9}
.goalmouth-wrap{position:relative;width:100%;padding-bottom:55%;background:#1a1a1a;border-radius:14px;overflow:hidden;border:3px solid #444}
.gm-post{position:absolute;background:#fff;border-radius:2px}
.gm-left{left:0;top:0;width:4px;height:100%}
.gm-right{right:0;top:0;width:4px;height:100%}
.gm-top{top:0;left:0;right:0;height:4px}
.gm-net{position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 14%,rgba(255,255,255,0.06) 14%,rgba(255,255,255,0.06) 15%),repeating-linear-gradient(90deg,transparent,transparent 10%,rgba(255,255,255,0.06) 10%,rgba(255,255,255,0.06) 11%)}
.gm-zone{position:absolute;transform:translate(-50%,-50%);width:28%;height:24%;border-radius:8px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:rgba(255,255,255,0.5);transition:background 0.15s}
.gm-zone:hover{background:rgba(255,255,255,0.2);color:#fff}
.gm-zone.selected{background:rgba(240,192,64,0.4);border-color:#f0c040;color:#f0c040}
.back-btn{display:flex;align-items:center;gap:6px;background:none;border:none;font-family:'Figtree',sans-serif;font-size:14px;font-weight:600;color:#555;cursor:pointer;padding:0;margin-bottom:4px}
.step-indicator{display:flex;gap:6px;align-items:center;margin-bottom:16px}
.step-dot{width:6px;height:6px;border-radius:50%;background:#e0e0e0}
.step-dot.done{background:#111}
.step-dot.active{background:#111;width:18px;border-radius:3px}
.no-matches{text-align:center;padding:32px 16px;color:#bbb;font-size:14px}
.match-history-item{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:0.5px solid #f5f5f0}
.match-history-item:last-child{border-bottom:none}
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
`;

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState(() => loadLocal() ?? defaultState);

  useEffect(() => {
    saveLocal(state);
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = await fetchSeasonFromSupabase();
        if (cancelled || remote == null) return;
        setState((prev) => ({ ...prev, season: remote }));
      } catch (e) {
        console.warn("Supabase load failed; using local cache", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (fn) => setState(prev => ({ ...prev, ...fn(prev) }));

  const { season, currentMatch, view, logStep, logData } = state;

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
    update(() => ({
      view: "new_match",
      currentMatch: {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        team1: { name: "Bibs", color: "#f59e0b", players: [] },
        team2: { name: "Skins", color: "#3b82f6", players: [] },
        score1: 0,
        score2: 0,
        events: [],
        motm: null,
        status: "setup",
      },
    }));
  };

  const saveCurrentMatch = () => {
    if (!currentMatch) return;
    setState((prev) => {
      if (!prev.currentMatch) return prev;
      const nextSeason = {
        ...prev.season,
        matches: [...prev.season.matches, prev.currentMatch],
      };
      upsertSeasonToSupabase(nextSeason).catch((e) => {
        console.warn("Supabase save failed; data kept in local storage", e);
      });
      return {
        ...prev,
        season: nextSeason,
        currentMatch: null,
        view: "dashboard",
      };
    });
  };

  // ── Event logging ──
  const startLogGoal = () => update(() => ({ logStep: "pitch", logData: {} }));

  const handlePitchClick = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    update(() => ({ logStep: "goalmouth", logData: { ...logData, pitchX: x, pitchY: y } }));
  };

  const handleGoalmouthSelect = (zone) => {
    update(() => ({ logStep: "how", logData: { ...logData, zone } }));
  };

  const handleHowSelect = (how) => {
    const howOpt = HOW_OPTIONS.find(h => h.value === how);
    const gmQuip = GOAL_QUIPS[logData.zone?.id] || "";
    const isOG = how === "own_goal";
    const event = {
      id: crypto.randomUUID(),
      type: "goal",
      how,
      team: logData.team || 1,
      player: logData.player || null,
      zone: logData.zone,
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
  const Dashboard = () => (
    <>
      <div className="topbar">
        <div className="topbar-logo">Wednesday FC ⚽</div>
        <div className="topbar-week">
          {season.matches.length > 0 ? `Week ${season.matches.length}` : "Season start"}
        </div>
      </div>

      {!lastMatch ? (
        <div className="card">
          <div className="no-matches">
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚽</div>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6, color: "#333" }}>No matches yet</div>
            <div>Get the lads together and log your first game.</div>
          </div>
          <button className="btn btn-primary" onClick={startNewMatch}>Log first match</button>
        </div>
      ) : (
        <>
          {/* Last match */}
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

          {/* Goal feed */}
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

          {/* MOTM */}
          {lastMatch.motm && (
            <div className="card card-sm">
              <div className="section-label">Man of the match</div>
              <div className="motm-card">
                <div className={`avatar avatar-lg avatar-amber`}>{initials(lastMatch.motm)}</div>
                <div>
                  <div className="motm-name">{lastMatch.motm}</div>
                  <div className="motm-sub">The lads voted. Can't argue with it.</div>
                </div>
              </div>
            </div>
          )}

          {/* Stats */}
          {allGoals.length > 0 && (
            <div className="stats-2col">
              <div className="card card-sm">
                <div className="section-label">Top scorer</div>
                {allGoals.slice(0, 3).map(([name, n], i) => (
                  <div className="stat-row" key={name}>
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

              <div className="card card-sm">
                <div className="section-label">Hall of shame</div>
                {allOGs.length > 0 ? allOGs.slice(0, 3).map(([name, n]) => (
                  <div className="stat-row" key={name}>
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
            </div>
          )}

          {/* Banter */}
          <div className="card card-sm">
            <div className="section-label">Season so far</div>
            {banter.map((line, i) => (
              <div className="banter-item" key={i}>
                <div className="banter-icon">{line.slice(0, 2)}</div>
                <div>{line.slice(2).trim()}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <button className="btn btn-primary" onClick={startNewMatch}>
        + Log this week's match
      </button>
    </>
  );

  // NEW MATCH SETUP
  const NewMatch = () => {
    const [localTeam1, setLocalTeam1] = useState(currentMatch?.team1 || { name: "Bibs", color: "#f59e0b", players: [] });
    const [localTeam2, setLocalTeam2] = useState(currentMatch?.team2 || { name: "Skins", color: "#3b82f6", players: [] });
    const [input1, setInput1] = useState("");
    const [input2, setInput2] = useState("");
    const [bulk, setBulk] = useState("");

    const addP = (team, name) => {
      if (!name.trim()) return;
      if (team === 1) { setLocalTeam1(t => ({ ...t, players: [...t.players, name.trim()] })); setInput1(""); }
      else { setLocalTeam2(t => ({ ...t, players: [...t.players, name.trim()] })); setInput2(""); }
    };
    const removeP = (team, i) => {
      if (team === 1) setLocalTeam1(t => ({ ...t, players: t.players.filter((_,j) => j!==i) }));
      else setLocalTeam2(t => ({ ...t, players: t.players.filter((_,j) => j!==i) }));
    };
    const bulkAdd = () => {
      const names = bulk.split(",").map(n=>n.trim()).filter(Boolean);
      const half = Math.ceil(names.length / 2);
      setLocalTeam1(t => ({ ...t, players: [...t.players, ...names.slice(0, half)] }));
      setLocalTeam2(t => ({ ...t, players: [...t.players, ...names.slice(half)] }));
      setBulk("");
    };
    const randomise = () => {
      const all = [...localTeam1.players, ...localTeam2.players];
      for (let i = all.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [all[i],all[j]]=[all[j],all[i]]; }
      const half = Math.ceil(all.length/2);
      setLocalTeam1(t => ({ ...t, players: all.slice(0, half) }));
      setLocalTeam2(t => ({ ...t, players: all.slice(half) }));
    };
    const proceed = () => {
      update(() => ({
        currentMatch: { ...currentMatch, team1: localTeam1, team2: localTeam2, status: "live" },
        view: "live",
      }));
    };

    return (
      <>
        <button className="back-btn" onClick={() => update(() => ({ view: "dashboard", currentMatch: null }))}>
          ← Back
        </button>
        <div style={{ fontWeight: 900, fontSize: 22, marginBottom: 16 }}>Set up teams</div>

        <div className="card card-sm" style={{ marginBottom: 10 }}>
          <div className="section-label">Bulk add players</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="form-input" style={{ flex: 1 }}
              placeholder="Dave, Steve, Marcus, Jordan..."
              value={bulk} onChange={e => setBulk(e.target.value)}
              onKeyDown={e => e.key === "Enter" && bulkAdd()}
            />
            <button className="btn btn-ghost btn-sm" onClick={bulkAdd}>Add</button>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={randomise}>
            🎲 Randomise teams
          </button>
        </div>

        <div className="teams-grid">
          {[1,2].map(t => {
            const team = t===1 ? localTeam1 : localTeam2;
            const setTeam = t===1 ? setLocalTeam1 : setLocalTeam2;
            const inp = t===1 ? input1 : input2;
            const setInp = t===1 ? setInput1 : setInput2;
            return (
              <div className="card card-sm" key={t}>
                <div className="team-label">
                  <div className="team-dot" style={{ background: team.color }} />
                  <input
                    value={team.name}
                    onChange={e => setTeam(tm => ({ ...tm, name: e.target.value }))}
                    style={{ background: "none", border: "none", fontFamily: "inherit", fontWeight: 800, fontSize: 14, width: "100%", outline: "none", color: "#111" }}
                  />
                </div>
                <div className="player-list">
                  {team.players.length === 0 && <div style={{ fontSize: 12, color: "#bbb", padding: "4px 0" }}>No players yet</div>}
                  {team.players.map((p, i) => (
                    <div className="player-tag" key={i}>
                      <span>{p}</span>
                      <button onClick={() => removeP(t, i)}>×</button>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <input
                    className="form-input" style={{ flex: 1, padding: "7px 10px", fontSize: 13 }}
                    placeholder="Add player..."
                    value={inp} onChange={e => setInp(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addP(t, inp)}
                  />
                  <button className="btn btn-ghost btn-sm" onClick={() => addP(t, inp)}>+</button>
                </div>
              </div>
            );
          })}
        </div>

        <button className="btn btn-primary" onClick={proceed} style={{ marginTop: 4 }}>
          Kick off →
        </button>
      </>
    );
  };

  // LIVE MATCH
  const LiveMatch = () => {
    const cm = currentMatch;
    if (!cm) return null;

    const setMOTM = (name) => update(prev => ({
      currentMatch: { ...prev.currentMatch, motm: name }
    }));

    const allMatchPlayers = [...(cm.team1.players || []), ...(cm.team2.players || [])];

    return (
      <>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <button className="back-btn" onClick={() => update(() => ({ view: "new_match" }))}>← Setup</button>
          <span style={{ fontSize: 12, color: "#999", fontWeight: 600 }}>Live</span>
        </div>

        {/* Live score */}
        <div className="card">
          <div className="score-row" style={{ marginBottom: 8 }}>
            <div className="score-team">
              <div className="score-team-name">{cm.team1.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button className="score-adj-btn" onClick={() => update(prev => {
                  const cm2 = { ...prev.currentMatch };
                  cm2.score1 = Math.max(0, cm2.score1 - 1);
                  return { currentMatch: cm2 };
                })}>−</button>
                <div className="live-score">{cm.score1}</div>
                <button className="score-adj-btn" onClick={() => update(prev => {
                  const cm2 = { ...prev.currentMatch };
                  cm2.score1 = cm2.score1 + 1;
                  return { currentMatch: cm2 };
                })}>+</button>
              </div>
            </div>
            <div className="score-vs">—</div>
            <div className="score-team">
              <div className="score-team-name">{cm.team2.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button className="score-adj-btn" onClick={() => update(prev => {
                  const cm2 = { ...prev.currentMatch };
                  cm2.score2 = Math.max(0, cm2.score2 - 1);
                  return { currentMatch: cm2 };
                })}>−</button>
                <div className="live-score">{cm.score2}</div>
                <button className="score-adj-btn" onClick={() => update(prev => {
                  const cm2 = { ...prev.currentMatch };
                  cm2.score2 = cm2.score2 + 1;
                  return { currentMatch: cm2 };
                })}>+</button>
              </div>
            </div>
          </div>

          {/* Team selector for goal log */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 8 }}>
              Log a goal for...
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[1,2].map(t => (
                <button
                  key={t}
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
        </div>

        {/* Player select step */}
        {logStep === "player" && (
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
        {logStep === "pitch" && (
          <div className="card card-sm">
            <div className="section-label">Where on the pitch?</div>
            <PitchSVG events={cm.events} onTap={handlePitchClick} />
            <div className="pitch-tap-hint">Tap where the shot came from</div>
          </div>
        )}

        {/* Goalmouth step */}
        {logStep === "goalmouth" && (
          <div className="card card-sm">
            <div className="section-label">Where did it go in?</div>
            <div className="goalmouth-wrap">
              <div className="gm-net" />
              <div className="gm-post gm-left" />
              <div className="gm-post gm-right" />
              <div className="gm-post gm-top" />
              {GOALMOUTH.map(z => (
                <button
                  key={z.id}
                  className={`gm-zone ${logData.zone?.id === z.id ? "selected" : ""}`}
                  style={{ left: z.x, top: z.y }}
                  onClick={() => handleGoalmouthSelect(z)}
                >
                  {z.label.split(" ")[0]}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* How scored step */}
        {logStep === "how" && (
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
                <button className="goal-del" onClick={() => removeEvent(ev.id)}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* MOTM */}
        {allMatchPlayers.length > 0 && (
          <div className="card card-sm">
            <div className="section-label">Man of the match</div>
            <div className="motm-select">
              {allMatchPlayers.map(p => (
                <button
                  key={p}
                  className={`motm-option ${cm.motm === p ? "selected" : ""}`}
                  onClick={() => setMOTM(p)}
                >
                  <div className="avatar" style={{ width: 24, height: 24, fontSize: 9, flexShrink: 0 }}>{initials(p)}</div>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        <button className="btn btn-green" onClick={saveCurrentMatch}>
          ✓ Save match
        </button>
        <button className="btn btn-ghost" onClick={() => update(() => ({ view: "dashboard", currentMatch: null }))}>
          Discard
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
          {[...season.matches].reverse().map((m, i) => {
            const winner = m.score1 > m.score2 ? m.team1.name : m.score2 > m.score1 ? m.team2.name : null;
            return (
              <div className="match-history-item" key={m.id}>
                <div>
                  <div className="mhi-score">{m.score1} — {m.score2}</div>
                  <div className="mhi-teams">{m.team1.name} vs {m.team2.name}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="mhi-date">{fmtDate(m.date)}</div>
                  {winner
                    ? <div style={{ fontSize: 11, color: "#27500a", fontWeight: 700, marginTop: 2 }}>{winner} win</div>
                    : <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Draw</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button className="btn btn-danger btn-sm" onClick={() => {
        if (window.confirm("Reset entire season? This cannot be undone.")) {
          const empty = { matches: [], players: [] };
          upsertSeasonToSupabase(empty).catch((e) => {
            console.warn("Supabase save failed; data kept in local storage", e);
          });
          update(() => ({ season: empty }));
        }
      }}>
        Reset season
      </button>
    </>
  );

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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        {view === "dashboard" && <Dashboard />}
        {view === "new_match" && <NewMatch />}
        {view === "live" && <LiveMatch />}
        {view === "history" && <History />}
      </div>

      {/* Bottom nav */}
      {!logStep && (
        <nav className="nav">
          <button className={`nav-btn ${view === "dashboard" ? "active" : ""}`} onClick={() => update(() => ({ view: "dashboard" }))}>
            <span className="nav-icon">🏠</span>Home
          </button>
          <button className={`nav-btn ${(view === "live" || view === "new_match") ? "active" : ""}`}
            onClick={() => currentMatch ? update(() => ({ view: "live" })) : startNewMatch()}>
            <span className="nav-icon">⚽</span>Match
          </button>
          <button className={`nav-btn ${view === "history" ? "active" : ""}`} onClick={() => update(() => ({ view: "history" }))}>
            <span className="nav-icon">📋</span>History
          </button>
        </nav>
      )}
    </>
  );
}
