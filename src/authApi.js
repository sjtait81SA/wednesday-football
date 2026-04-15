import { evaluateAchievementsAfterSave } from "./achievementsEngine.js";

/**
 * Email magic link (no OTP in-app). User completes sign-in via inbox link.
 * `emailRedirectTo` should be your app origin (e.g. window.location.origin).
 */
export async function sendMagicLinkEmail(supabase, email, emailRedirectTo) {
  if (!supabase) throw new Error("Supabase not configured");
  const trimmed = (email || "").trim();
  if (!trimmed) throw new Error("Enter your email");
  const redirect =
    emailRedirectTo ||
    (typeof window !== "undefined" ? window.location.origin : undefined);
  const { error } = await supabase.auth.signInWithOtp({
    email: trimmed,
    options: redirect ? { emailRedirectTo: redirect } : undefined,
  });
  if (error) throw error;
}

export async function signOut(supabase) {
  if (!supabase) return;
  await supabase.auth.signOut();
}

/**
 * Idempotent: inserts WNF_SQUAD into `players` only when the table has zero rows.
 * Requires RPC `seed_wnf_players_if_empty` (see supabase SQL).
 */
export async function seedPlayersIfEmpty(supabase) {
  if (!supabase) return;
  const { error } = await supabase.rpc("seed_wnf_players_if_empty");
  if (error) {
    console.warn("seedPlayersIfEmpty", error.message || error);
  }
}

/** Current user's claimed player row, or null if none */
export async function fetchMyPlayer(supabase) {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("players")
    .select("id,name,claimed_by,is_admin,created_at")
    .eq("claimed_by", user.id)
    .maybeSingle();
  if (error) {
    console.warn("fetchMyPlayer", error);
    return null;
  }
  return data;
}

/** Lookup by exact name (trimmed) for profile / claim UI */
export async function fetchPlayerByName(supabase, name) {
  if (!supabase || !name?.trim()) return null;
  const { data, error } = await supabase
    .from("players")
    .select("id,name,claimed_by,is_admin")
    .eq("name", name.trim())
    .maybeSingle();
  if (error) {
    console.warn("fetchPlayerByName", error);
    return null;
  }
  return data;
}

export async function fetchPlayersByNames(supabase, names) {
  if (!supabase || !names?.length) return [];
  const { data, error } = await supabase
    .from("players")
    .select("id,name,claimed_by,is_admin")
    .in("name", names);
  if (error) {
    console.warn("fetchPlayersByNames", error);
    return [];
  }
  return data || [];
}

export async function fetchUnclaimedPlayersForSquad(supabase, squadNames) {
  if (!supabase || !squadNames?.length) return [];
  const { data, error } = await supabase
    .from("players")
    .select("id,name,claimed_by")
    .in("name", squadNames)
    .is("claimed_by", null);
  if (error) {
    console.warn("fetchUnclaimedPlayersForSquad", error);
    return [];
  }
  return data || [];
}

export async function insertPlayerRow(supabase, name, claim) {
  if (!supabase) throw new Error("Supabase not configured");
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const row = {
    name: name.trim(),
    ...(claim ? { claimed_by: user.id } : { claimed_by: null }),
  };
  const { data, error } = await supabase.from("players").insert(row).select("id,name,claimed_by,is_admin").single();
  if (error) throw error;
  return data;
}

export async function claimPlayerRow(supabase, playerId) {
  if (!supabase) throw new Error("Supabase not configured");
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data, error } = await supabase
    .from("players")
    .update({ claimed_by: user.id })
    .eq("id", playerId)
    .is("claimed_by", null)
    .select("id,name,claimed_by,is_admin")
    .single();
  if (error) throw error;
  return data;
}

export async function fetchAchievementsForPlayer(supabase, playerId) {
  if (!supabase || !playerId) return [];
  const { data, error } = await supabase
    .from("achievements")
    .select("id,type,earned_at,match_id")
    .eq("player_id", playerId)
    .order("earned_at", { ascending: false });
  if (error) {
    console.warn("fetchAchievementsForPlayer", error);
    return [];
  }
  return data || [];
}

export async function fetchLatestAchievementFeed(supabase) {
  if (!supabase) return null;
  const { data: ach, error } = await supabase
    .from("achievements")
    .select("id,type,earned_at,player_id,match_id")
    .order("earned_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !ach) {
    if (error) console.warn("fetchLatestAchievementFeed", error);
    return null;
  }
  const { data: pl } = await supabase.from("players").select("name").eq("id", ach.player_id).maybeSingle();
  return { ...ach, players: pl ? { name: pl.name } : null };
}

export async function insertAchievementIfNew(supabase, playerId, type, matchId) {
  if (!supabase || !playerId) return null;
  let q = supabase.from("achievements").select("id").eq("player_id", playerId).eq("type", type);
  q = matchId ? q.eq("match_id", matchId) : q.is("match_id", null);
  const { data: existing } = await q.limit(1).maybeSingle();
  if (existing) return null;
  const { data, error } = await supabase
    .from("achievements")
    .insert({
      player_id: playerId,
      type,
      match_id: matchId || null,
      earned_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return null;
    console.warn("insertAchievementIfNew", error);
    return null;
  }
  return data;
}

/** Remove match-scoped achievement rows (requires `achievements_delete_admin` RLS policy). */
export async function deleteAchievementsForMatchIds(supabase, matchIds) {
  if (!supabase || !matchIds?.length) return;
  const { error } = await supabase.from("achievements").delete().in("match_id", matchIds);
  if (error) console.warn("deleteAchievementsForMatchIds", error);
}

/** Build name → player id map (first match wins) */
export async function fetchNameToPlayerIdMap(supabase) {
  if (!supabase) return new Map();
  const { data, error } = await supabase.from("players").select("id,name");
  if (error) {
    console.warn("fetchNameToPlayerIdMap", error);
    return new Map();
  }
  const m = new Map();
  (data || []).forEach((r) => {
    const n = (r.name || "").trim();
    if (n && !m.has(n)) m.set(n, r.id);
  });
  return m;
}

/** Ensure a row exists for each squad name (unclaimed). */
export async function syncSquadNamesToPlayers(supabase, squadNames) {
  if (!supabase || !squadNames?.length) return;
  const { data: existing } = await supabase.from("players").select("name");
  const have = new Set((existing || []).map((r) => (r.name || "").trim()));
  for (const raw of squadNames) {
    const name = (raw || "").trim();
    if (!name || have.has(name)) continue;
    const { error } = await supabase.from("players").insert({ name, claimed_by: null });
    if (error && error.code !== "23505") console.warn("syncSquadNamesToPlayers", name, error);
    else have.add(name);
  }
}

export async function processAchievementsForSavedMatch(supabase, season, savedMatch) {
  if (!supabase || !savedMatch) return [];
  const awards = evaluateAchievementsAfterSave(season, savedMatch);
  const nameMap = await fetchNameToPlayerIdMap(supabase);
  const inserted = [];
  for (const a of awards) {
    const pid = nameMap.get((a.playerName || "").trim());
    if (!pid) continue;
    const row = await insertAchievementIfNew(supabase, pid, a.type, a.matchId);
    if (row) inserted.push({ ...a, playerId: pid });
  }
  return inserted;
}
