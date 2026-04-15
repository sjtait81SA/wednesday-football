import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Trash2, Goal, Shield, RotateCcw, Download } from "lucide-react";

const STORAGE_KEY = "wednesday-football-match-v1";
const PITCH_W = 100;
const PITCH_H = 60;

const defaultMatch = {
  title: "Wednesday Night Football",
  venue: "5-a-side",
  date: new Date().toISOString().slice(0, 10),
  teamA: "Reds",
  teamB: "Blues",
  scoreA: 0,
  scoreB: 0,
  shots: [],
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : defaultMatch;
  } catch {
    return defaultMatch;
  }
}

function ShotDot({ shot, onRemove }) {
  const fill = shot.outcome === "goal" ? "rgba(185, 28, 28, 0.75)" : "rgba(255,255,255,0.95)";
  const stroke = shot.outcome === "goal" ? "rgba(127, 29, 29, 0.95)" : "rgba(30, 41, 59, 0.95)";
  const r = 0.8 + shot.xg * 2.2;

  return (
    <g onClick={() => onRemove(shot.id)} className="cursor-pointer">
      <circle cx={shot.x} cy={shot.y} r={r} fill={fill} stroke={stroke} strokeWidth="0.22" />
    </g>
  );
}

function Pitch({ shots, onAddShot, onRemoveShot }) {
  const handleClick = (e) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * PITCH_W;
    const y = ((e.clientY - rect.top) / rect.height) * PITCH_H;
    onAddShot({ x: clamp(x, 1, 99), y: clamp(y, 1, 59) });
  };

  return (
    <div className="w-full overflow-hidden rounded-3xl border bg-white shadow-sm">
      <svg
        viewBox={`0 0 ${PITCH_W} ${PITCH_H}`}
        className="w-full aspect-[10/6] bg-[#f8fafc]"
        onClick={handleClick}
      >
        <rect x="0" y="0" width={PITCH_W} height={PITCH_H} fill="#f8fafc" />
        <rect x="2" y="2" width={96} height={56} fill="none" stroke="#475569" strokeWidth="0.6" />
        <line x1="50" y1="2" x2="50" y2="58" stroke="#94a3b8" strokeWidth="0.35" strokeDasharray="1.2 1.2" />
        <circle cx="50" cy="30" r="8" fill="none" stroke="#94a3b8" strokeWidth="0.35" />
        <circle cx="50" cy="30" r="0.45" fill="#94a3b8" />

        <rect x="18" y="2" width="64" height="18" fill="none" stroke="#475569" strokeWidth="0.45" />
        <rect x="33" y="2" width="34" height="8" fill="none" stroke="#475569" strokeWidth="0.4" />
        <rect x="46" y="0.8" width="8" height="1.2" fill="none" stroke="#475569" strokeWidth="0.35" />
        <circle cx="50" cy="14" r="0.4" fill="#64748b" />
        <path d="M42,20 A8,8 0 0,0 58,20" fill="none" stroke="#64748b" strokeWidth="0.3" />

        <rect x="18" y="40" width="64" height="18" fill="none" stroke="#475569" strokeWidth="0.45" />
        <rect x="33" y="50" width="34" height="8" fill="none" stroke="#475569" strokeWidth="0.4" />
        <rect x="46" y="58" width="8" height="1.2" fill="none" stroke="#475569" strokeWidth="0.35" />
        <circle cx="50" cy="46" r="0.4" fill="#64748b" />
        <path d="M42,40 A8,8 0 0,1 58,40" fill="none" stroke="#64748b" strokeWidth="0.3" />

        {shots.map((shot) => (
          <ShotDot key={shot.id} shot={shot} onRemove={onRemoveShot} />
        ))}
      </svg>
    </div>
  );
}

function StatCard({ label, value, subtext }) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
        <div className="mt-2 text-3xl font-semibold text-slate-900">{value}</div>
        {subtext ? <div className="mt-1 text-sm text-slate-500">{subtext}</div> : null}
      </CardContent>
    </Card>
  );
}

export default function WednesdayFootballShotmapApp() {
  const [match, setMatch] = useState(defaultMatch);
  const [selectedTeam, setSelectedTeam] = useState("A");
  const [selectedOutcome, setSelectedOutcome] = useState("goal");
  const [selectedMethod, setSelectedMethod] = useState("open_play");
  const [selectedXg, setSelectedXg] = useState("0.25");

  useEffect(() => {
    setMatch(loadState());
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(match));
  }, [match]);

  const stats = useMemo(() => {
    const shotsA = match.shots.filter((s) => s.team === "A");
    const shotsB = match.shots.filter((s) => s.team === "B");
    const goals = match.shots.filter((s) => s.outcome === "goal").length;
    const saves = match.shots.filter((s) => s.outcome === "save").length;
    const totalXg = match.shots.reduce((sum, s) => sum + Number(s.xg || 0), 0);
    const goalsA = shotsA.filter((s) => s.outcome === "goal").length;
    const goalsB = shotsB.filter((s) => s.outcome === "goal").length;

    return {
      totalShots: match.shots.length,
      totalXg: totalXg.toFixed(2),
      goals,
      saves,
      shotsA: shotsA.length,
      shotsB: shotsB.length,
      goalsA,
      goalsB,
    };
  }, [match.shots]);

  const addShot = ({ x, y }) => {
    const newShot = {
      id: crypto.randomUUID(),
      x,
      y,
      team: selectedTeam,
      outcome: selectedOutcome,
      method: selectedMethod,
      xg: Number(selectedXg),
      createdAt: new Date().toISOString(),
    };

    setMatch((prev) => {
      const next = { ...prev, shots: [...prev.shots, newShot] };
      next.scoreA = next.shots.filter((s) => s.team === "A" && s.outcome === "goal").length;
      next.scoreB = next.shots.filter((s) => s.team === "B" && s.outcome === "goal").length;
      return next;
    });
  };

  const removeShot = (id) => {
    setMatch((prev) => {
      const nextShots = prev.shots.filter((s) => s.id !== id);
      return {
        ...prev,
        shots: nextShots,
        scoreA: nextShots.filter((s) => s.team === "A" && s.outcome === "goal").length,
        scoreB: nextShots.filter((s) => s.team === "B" && s.outcome === "goal").length,
      };
    });
  };

  const resetMatch = () => {
    setMatch({ ...defaultMatch, date: new Date().toISOString().slice(0, 10) });
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(match, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${match.date}-${match.teamA}-vs-${match.teamB}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Match Reporter</div>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">Wednesday Night Football</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              Set your teams, tap the pitch to log shots, and build a simple post-match shot map.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="rounded-2xl" onClick={exportJson}>
              <Download className="mr-2 h-4 w-4" /> Export JSON
            </Button>
            <Button variant="outline" className="rounded-2xl" onClick={resetMatch}>
              <RotateCcw className="mr-2 h-4 w-4" /> Reset Match
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <StatCard label="Score" value={`${match.scoreA} - ${match.scoreB}`} subtext={`${match.teamA} vs ${match.teamB}`} />
          <StatCard label="Shots Logged" value={stats.totalShots} subtext={`${stats.shotsA} for ${match.teamA}, ${stats.shotsB} for ${match.teamB}`} />
          <StatCard label="Goals" value={stats.goals} subtext="Tap any dot to delete it" />
          <StatCard label="Total xG" value={stats.totalXg} subtext="Basic manually assigned value" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <Card className="rounded-3xl shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xl">Shot Map</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="space-y-2">
                  <Label>Team</Label>
                  <Select value={selectedTeam} onValueChange={setSelectedTeam}>
                    <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="A">{match.teamA}</SelectItem>
                      <SelectItem value="B">{match.teamB}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Outcome</Label>
                  <Select value={selectedOutcome} onValueChange={setSelectedOutcome}>
                    <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="goal">Goal</SelectItem>
                      <SelectItem value="save">Save</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Method</Label>
                  <Select value={selectedMethod} onValueChange={setSelectedMethod}>
                    <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open_play">Open play</SelectItem>
                      <SelectItem value="counter">Counter</SelectItem>
                      <SelectItem value="set_piece">Set piece</SelectItem>
                      <SelectItem value="penalty">Penalty</SelectItem>
                      <SelectItem value="long_shot">Long shot</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>xG Size</Label>
                  <Select value={selectedXg} onValueChange={setSelectedXg}>
                    <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0.05">Very low</SelectItem>
                      <SelectItem value="0.10">Low</SelectItem>
                      <SelectItem value="0.25">Medium</SelectItem>
                      <SelectItem value="0.40">Big chance</SelectItem>
                      <SelectItem value="0.60">Huge chance</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-2xl border bg-slate-50 p-3 text-sm text-slate-600">
                  Click the pitch to place the shot.<br />
                  <span className="font-medium text-slate-900">Red filled</span> = goal, <span className="font-medium text-slate-900">white ring</span> = save.
                </div>
              </div>

              <Pitch shots={match.shots} onAddShot={addShot} onRemoveShot={removeShot} />

              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
                <div className="flex items-center gap-2"><span className="h-4 w-4 rounded-full border border-slate-800 bg-white" /> Save</div>
                <div className="flex items-center gap-2"><span className="h-4 w-4 rounded-full bg-red-700/70" /> Goal</div>
                <Badge variant="secondary" className="rounded-xl">Tap a dot to remove</Badge>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card className="rounded-3xl shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl">Match Setup</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="space-y-2">
                  <Label>Match title</Label>
                  <Input
                    className="rounded-2xl"
                    value={match.title}
                    onChange={(e) => setMatch((prev) => ({ ...prev, title: e.target.value }))}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Team A</Label>
                    <Input
                      className="rounded-2xl"
                      value={match.teamA}
                      onChange={(e) => setMatch((prev) => ({ ...prev, teamA: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Team B</Label>
                    <Input
                      className="rounded-2xl"
                      value={match.teamB}
                      onChange={(e) => setMatch((prev) => ({ ...prev, teamB: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Date</Label>
                    <Input
                      type="date"
                      className="rounded-2xl"
                      value={match.date}
                      onChange={(e) => setMatch((prev) => ({ ...prev, date: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Venue</Label>
                    <Input
                      className="rounded-2xl"
                      value={match.venue}
                      onChange={(e) => setMatch((prev) => ({ ...prev, venue: e.target.value }))}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-3xl shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl">Event Log</CardTitle>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="all" className="w-full">
                  <TabsList className="grid w-full grid-cols-3 rounded-2xl">
                    <TabsTrigger value="all">All</TabsTrigger>
                    <TabsTrigger value="A">{match.teamA}</TabsTrigger>
                    <TabsTrigger value="B">{match.teamB}</TabsTrigger>
                  </TabsList>

                  {[
                    { key: "all", label: "all" },
                    { key: "A", label: match.teamA },
                    { key: "B", label: match.teamB },
                  ].map((tab) => {
                    const filtered = match.shots.filter((s) => tab.key === "all" || s.team === tab.key);
                    return (
                      <TabsContent key={tab.key} value={tab.key} className="mt-4 space-y-3">
                        {filtered.length === 0 ? (
                          <div className="rounded-2xl border border-dashed p-6 text-sm text-slate-500">
                            No events yet. Start clicking the pitch.
                          </div>
                        ) : (
                          filtered
                            .slice()
                            .reverse()
                            .map((shot, index) => (
                              <div key={shot.id} className="flex items-start justify-between gap-3 rounded-2xl border p-3">
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                                    {shot.outcome === "goal" ? (
                                      <Goal className="h-4 w-4" />
                                    ) : (
                                      <Shield className="h-4 w-4" />
                                    )}
                                    {shot.team === "A" ? match.teamA : match.teamB} · {shot.outcome}
                                  </div>
                                  <div className="text-sm text-slate-600">
                                    {shot.method.replaceAll("_", " ")} · xG {Number(shot.xg).toFixed(2)} · ({shot.x.toFixed(1)}, {shot.y.toFixed(1)})
                                  </div>
                                  <div className="text-xs text-slate-400">Event #{filtered.length - index}</div>
                                </div>
                                <Button variant="ghost" size="icon" className="rounded-xl" onClick={() => removeShot(shot.id)}>
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            ))
                        )}
                      </TabsContent>
                    );
                  })}
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
