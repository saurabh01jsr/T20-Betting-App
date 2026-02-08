const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { Pool } = require("pg");
const { XMLParser } = require("fast-xml-parser");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const SCHEDULE_FEED_URL =
  process.env.SCHEDULE_FEED_URL ||
  "https://fixturedownload.com/feed/json/mens-t20-world-cup-2026";
const GOALSERVE_TOSS_FEED_URL = process.env.GOALSERVE_TOSS_FEED_URL || "";
const TOSS_SYNC_INTERVAL_MS = Math.max(
  15000,
  Number(process.env.TOSS_SYNC_INTERVAL_SECONDS || 60) * 1000
);
const TOSS_SYNC_WINDOW_MINUTES = Math.max(
  60,
  Number(process.env.TOSS_SYNC_WINDOW_MINUTES || 360)
);
const USE_DB = Boolean(process.env.DATABASE_URL);
const pool = USE_DB
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
    })
  : null;
let dbInitialized = false;

app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

function hashPin(pin) {
  return crypto.createHash("sha256").update(String(pin)).digest("hex");
}

function defaultData() {
  return {
    settings: {
      roomName: "T20 Score Predictions",
      usePin: false,
      adminPinHash: null,
      bonusExact: 0,
      minScore: 60,
      maxScore: 300,
      lockMinutesBeforeStart: 15,
      scheduleSource: "Fixture Download (ICC schedule)",
      lastScheduleSync: null,
      tossAutoEnabled: true,
      tossAutoSource: "Goalserve",
      lastTossSync: null
    },
    players: [],
    matches: []
  };
}

async function initDb() {
  if (!USE_DB || dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      room_name TEXT NOT NULL,
      use_pin BOOLEAN NOT NULL DEFAULT FALSE,
      admin_pin_hash TEXT,
      bonus_exact INTEGER NOT NULL DEFAULT 0,
      min_score INTEGER NOT NULL DEFAULT 60,
      max_score INTEGER NOT NULL DEFAULT 300,
      lock_minutes_before_start INTEGER NOT NULL DEFAULT 15,
      schedule_source TEXT,
      last_schedule_sync TIMESTAMPTZ,
      toss_auto_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      toss_auto_source TEXT,
      last_toss_sync TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      external_id TEXT UNIQUE,
      match_number INTEGER,
      round_number INTEGER,
      team_a TEXT,
      team_b TEXT,
      venue TEXT,
      group_name TEXT,
      stage TEXT,
      match_date TIMESTAMPTZ,
      lock_time TIMESTAMPTZ,
      status TEXT NOT NULL,
      predictions JSONB NOT NULL DEFAULT '{}'::jsonb,
      actual_score INTEGER,
      result JSONB,
      goalserve_match_id TEXT,
      innings1_status TEXT,
      innings2_status TEXT,
      innings1_lock_time TIMESTAMPTZ,
      innings2_lock_time TIMESTAMPTZ,
      innings1_score INTEGER,
      innings2_score INTEGER,
      toss_winner TEXT,
      toss_decision TEXT
    );
  `);
  await pool.query(`
    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS goalserve_match_id TEXT,
      ADD COLUMN IF NOT EXISTS innings1_status TEXT,
      ADD COLUMN IF NOT EXISTS innings2_status TEXT,
      ADD COLUMN IF NOT EXISTS innings1_lock_time TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS innings2_lock_time TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS innings1_score INTEGER,
      ADD COLUMN IF NOT EXISTS innings2_score INTEGER,
      ADD COLUMN IF NOT EXISTS toss_winner TEXT,
      ADD COLUMN IF NOT EXISTS toss_decision TEXT;
  `);
  await pool.query(`
    ALTER TABLE settings
      ADD COLUMN IF NOT EXISTS toss_auto_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS toss_auto_source TEXT,
      ADD COLUMN IF NOT EXISTS last_toss_sync TIMESTAMPTZ;
  `);
  dbInitialized = true;
}

function rowToMatch(row) {
  const innings1Lock =
    row.innings1_lock_time || row.lock_time ? new Date(row.innings1_lock_time || row.lock_time) : null;
  return {
    id: row.id,
    externalId: row.external_id,
    matchNumber: row.match_number,
    roundNumber: row.round_number,
    teamA: row.team_a,
    teamB: row.team_b,
    venue: row.venue,
    group: row.group_name,
    stage: row.stage,
    matchDate: row.match_date ? new Date(row.match_date).toISOString() : null,
    lockTime: row.lock_time ? new Date(row.lock_time).toISOString() : null,
    status: row.status,
    goalserveMatchId: row.goalserve_match_id || null,
    innings1: {
      status: row.innings1_status || row.status || "open",
      lockTime: innings1Lock ? innings1Lock.toISOString() : null,
      score: row.innings1_score ?? row.actual_score ?? null
    },
    innings2: {
      status: row.innings2_status || "pending",
      lockTime: row.innings2_lock_time ? new Date(row.innings2_lock_time).toISOString() : null,
      score: row.innings2_score ?? null
    },
    predictions: row.predictions || {},
    actualScore: row.actual_score,
    result: row.result || null,
    toss: row.toss_winner && row.toss_decision ? { winner: row.toss_winner, decision: row.toss_decision } : null
  };
}

async function readData() {
  if (!USE_DB) {
    if (!fs.existsSync(DATA_FILE)) {
      const initial = defaultData();
      await saveData(initial);
      return initial;
    }
    try {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      const defaults = defaultData();
      return {
        ...defaults,
        ...parsed,
        settings: { ...defaults.settings, ...parsed.settings }
      };
    } catch (err) {
      const fallback = defaultData();
      await saveData(fallback);
      return fallback;
    }
  }

  await initDb();
  const defaults = defaultData();
  const settingsResult = await pool.query("SELECT * FROM settings WHERE id = 1");
  const settingsRow = settingsResult.rows[0];
  const settings = settingsRow
    ? {
        roomName: settingsRow.room_name,
        usePin: settingsRow.use_pin,
        adminPinHash: settingsRow.admin_pin_hash,
        bonusExact: settingsRow.bonus_exact,
        minScore: settingsRow.min_score,
        maxScore: settingsRow.max_score,
        lockMinutesBeforeStart: settingsRow.lock_minutes_before_start,
        scheduleSource: settingsRow.schedule_source,
        lastScheduleSync: settingsRow.last_schedule_sync
          ? new Date(settingsRow.last_schedule_sync).toISOString()
          : null,
        tossAutoEnabled: settingsRow.toss_auto_enabled ?? true,
        tossAutoSource: settingsRow.toss_auto_source || "Goalserve",
        lastTossSync: settingsRow.last_toss_sync
          ? new Date(settingsRow.last_toss_sync).toISOString()
          : null
      }
    : defaults.settings;

  const players = (await pool.query("SELECT id, name FROM players ORDER BY name ASC")).rows;
  const matches = (await pool.query("SELECT * FROM matches ORDER BY match_date NULLS LAST")).rows.map(
    rowToMatch
  );

  return {
    settings: { ...defaults.settings, ...settings },
    players,
    matches
  };
}

async function saveData(data) {
  if (!USE_DB) {
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
    return;
  }

  await initDb();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM matches");
    await client.query("DELETE FROM players");
    await client.query("DELETE FROM settings");
    await client.query(
      `
      INSERT INTO settings (
        id, room_name, use_pin, admin_pin_hash, bonus_exact,
        min_score, max_score, lock_minutes_before_start, schedule_source, last_schedule_sync,
        toss_auto_enabled, toss_auto_source, last_toss_sync
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `,
      [
        1,
        data.settings.roomName,
        data.settings.usePin,
        data.settings.adminPinHash,
        data.settings.bonusExact,
        data.settings.minScore,
        data.settings.maxScore,
        data.settings.lockMinutesBeforeStart,
        data.settings.scheduleSource,
        data.settings.lastScheduleSync,
        data.settings.tossAutoEnabled,
        data.settings.tossAutoSource,
        data.settings.lastTossSync
      ]
    );

    for (const player of data.players) {
      await client.query("INSERT INTO players (id, name) VALUES ($1,$2)", [
        player.id,
        player.name
      ]);
    }

    for (const match of data.matches) {
      await client.query(
        `
        INSERT INTO matches (
          id, external_id, match_number, round_number, team_a, team_b, venue,
          group_name, stage, match_date, lock_time, status, predictions, actual_score, result,
          goalserve_match_id, innings1_status, innings2_status, innings1_lock_time, innings2_lock_time,
          innings1_score, innings2_score, toss_winner, toss_decision
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      `,
        [
          match.id,
          match.externalId,
          match.matchNumber,
          match.roundNumber,
          match.teamA,
          match.teamB,
          match.venue,
          match.group,
          match.stage,
          match.matchDate,
          match.innings1?.lockTime || match.lockTime,
          match.innings1?.status || match.status || "open",
          match.predictions || {},
          match.innings1?.score ?? match.actualScore,
          match.result,
          match.goalserveMatchId || null,
          match.innings1?.status || null,
          match.innings2?.status || null,
          match.innings1?.lockTime || null,
          match.innings2?.lockTime || null,
          match.innings1?.score ?? null,
          match.innings2?.score ?? null,
          match.toss?.winner || null,
          match.toss?.decision || null
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureAdmin(data, pin) {
  if (!data.settings.usePin) return true;
  if (!pin) return false;
  return hashPin(pin) === data.settings.adminPinHash;
}

function parseDateUtc(value) {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function computeLockTime(matchDateIso, lockMinutes) {
  if (!matchDateIso) return null;
  const date = new Date(matchDateIso);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = Number.isFinite(lockMinutes) ? lockMinutes : 0;
  const lock = new Date(date.getTime() - minutes * 60 * 1000);
  return lock.toISOString();
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Fetch failed with status ${res.statusCode}`));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve(data);
      });
    });
    req.on("error", reject);
  });
}

async function fetchJson(url) {
  const text = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error("Expected JSON but received non-JSON response.");
  }
}

function deriveStage(matchNumber, group) {
  if (group) return "Group Stage";
  if (matchNumber >= 41 && matchNumber <= 52) return "Super 8";
  if (matchNumber >= 53 && matchNumber <= 54) return "Semi Final";
  if (matchNumber === 55) return "Final";
  return "Knockout";
}

function normalizeFixtureRow(row, settings) {
  const matchNumber = Number(row.MatchNumber);
  const roundNumber = Number(row.RoundNumber);
  const matchDate = parseDateUtc(row.DateUtc);
  const lockTime = computeLockTime(matchDate, settings.lockMinutesBeforeStart);
  const stage = deriveStage(matchNumber, row.Group);
  return {
    externalId: `fixture_${matchNumber}`,
    matchNumber: Number.isFinite(matchNumber) ? matchNumber : null,
    roundNumber: Number.isFinite(roundNumber) ? roundNumber : null,
    teamA: String(row.HomeTeam || "TBD"),
    teamB: String(row.AwayTeam || "TBD"),
    venue: String(row.Location || "TBD"),
    group: row.Group ? String(row.Group) : null,
    stage,
    matchDate,
    lockTime
  };
}

async function importSchedule(data) {
  const schedule = await fetchJson(SCHEDULE_FEED_URL);
  if (!Array.isArray(schedule)) {
    throw new Error("Schedule format is invalid.");
  }

  const existingByExternal = new Map();
  for (const match of data.matches) {
    if (match.externalId) existingByExternal.set(match.externalId, match);
  }

  let created = 0;
  let updated = 0;

  for (const row of schedule) {
    const normalized = normalizeFixtureRow(row, data.settings);
    const existing = existingByExternal.get(normalized.externalId);
    if (existing) {
      existing.teamA = normalized.teamA;
      existing.teamB = normalized.teamB;
      existing.venue = normalized.venue;
      existing.group = normalized.group;
      existing.stage = normalized.stage;
      existing.matchDate = normalized.matchDate;
      if (existing.innings1) {
        existing.innings1.lockTime = normalized.lockTime;
      } else {
        existing.lockTime = normalized.lockTime;
      }
      existing.matchNumber = normalized.matchNumber;
      existing.roundNumber = normalized.roundNumber;
      updated += 1;
    } else {
      data.matches.push({
        id: makeId("match"),
        status: "open",
        predictions: { innings1: {}, innings2: {} },
        result: null,
        toss: null,
        innings1: {
          status: "open",
          lockTime: normalized.lockTime,
          score: null
        },
        innings2: {
          status: "pending",
          lockTime: null,
          score: null
        },
        ...normalized
      });
      created += 1;
    }
  }

  data.settings.lastScheduleSync = new Date().toISOString();
  return { created, updated, total: schedule.length };
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseGoalserveDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split(".").map(Number);
  if (!day || !month || !year) return null;
  let hour = 0;
  let minute = 0;
  if (timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    hour = Number.isFinite(h) ? h : 0;
    minute = Number.isFinite(m) ? m : 0;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseTossText(text, teamA, teamB) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const teams = [teamA, teamB];
  const winner = teams.find((team) => lower.includes(String(team).toLowerCase()));
  if (!winner) return null;
  const decision =
    /elected to field|opted to field|chose to field|decided to field|elected to bowl|opted to bowl|chose to bowl|decided to bowl/.test(
      lower
    )
      ? "field"
      : /elected to bat|opted to bat|chose to bat|decided to bat/.test(lower)
        ? "bat"
        : null;
  if (!decision) return null;
  return { winner, decision };
}

function extractGoalserveMatches(payload) {
  const container =
    payload?.scores ||
    payload?.fixtures ||
    payload?.category ||
    payload?.data ||
    payload;
  const categories = Array.isArray(container?.category)
    ? container.category
    : container?.category
      ? [container.category]
      : Array.isArray(container)
        ? container
        : [];

  const matches = [];
  for (const category of categories) {
    const matchList = Array.isArray(category.match)
      ? category.match
      : category.match
        ? [category.match]
        : [];
    for (const match of matchList) {
      const infoList = Array.isArray(match?.matchinfo?.info)
        ? match.matchinfo.info
        : match?.matchinfo?.info
          ? [match.matchinfo.info]
          : [];
      const tossInfo = infoList.find((info) => String(info?.name || "").toLowerCase() === "toss");
      const tossText =
        tossInfo?.value ||
        tossInfo?.["@_value"] ||
        match?.comment?.["@_post"] ||
        match?.comment?.post ||
        null;

      matches.push({
        id: match?.["@_id"] || match?.id || match?.match_id || match?.mid || null,
        date: match?.date || match?.["@_date"] || null,
        time: match?.time || match?.["@_time"] || null,
        localTeam:
          match?.localteam?.["@_name"] ||
          match?.localteam?.name ||
          match?.home?.name ||
          match?.home?.["@_name"] ||
          match?.hometeam ||
          null,
        visitorTeam:
          match?.visitorteam?.["@_name"] ||
          match?.visitorteam?.name ||
          match?.away?.name ||
          match?.away?.["@_name"] ||
          match?.awayteam ||
          null,
        tossText
      });
    }
  }
  return matches;
}

async function syncTossFromGoalserve(data, force = false) {
  if (!GOALSERVE_TOSS_FEED_URL) {
    return { skipped: true, reason: "GOALSERVE_TOSS_FEED_URL not configured." };
  }
  if (!data.settings.tossAutoEnabled && !force) {
    return { skipped: true, reason: "Toss auto sync disabled." };
  }

  const now = Date.now();
  if (!force && data.settings.lastTossSync) {
    const last = new Date(data.settings.lastTossSync).getTime();
    if (!Number.isNaN(last) && now - last < TOSS_SYNC_INTERVAL_MS) {
      return { skipped: true, reason: "Throttled." };
    }
  }

  const windowMs = TOSS_SYNC_WINDOW_MINUTES * 60 * 1000;
  const candidates = data.matches.filter((match) => {
    if (match.toss) return false;
    if (!match.matchDate) return true;
    const start = new Date(match.matchDate).getTime();
    if (Number.isNaN(start)) return true;
    return Math.abs(start - now) <= windowMs;
  });

  if (!candidates.length) {
    data.settings.lastTossSync = new Date().toISOString();
    return { skipped: true, reason: "No pending matches in window." };
  }

  const raw = await fetchText(GOALSERVE_TOSS_FEED_URL);
  const parsed = raw.trim().startsWith("{")
    ? JSON.parse(raw)
    : new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(raw);
  const feedMatches = extractGoalserveMatches(parsed);

  let updated = 0;
  for (const match of candidates) {
    const teamAKey = normalizeTeamName(match.teamA);
    const teamBKey = normalizeTeamName(match.teamB);
    const matchDateKey = match.matchDate ? match.matchDate.slice(0, 10) : null;

    const matched = feedMatches.find((item) => {
      if (match.goalserveMatchId && item.id && String(item.id) === String(match.goalserveMatchId)) {
        return true;
      }
      const localKey = normalizeTeamName(item.localTeam);
      const visitorKey = normalizeTeamName(item.visitorTeam);
      if (!localKey || !visitorKey) return false;
      const teamsMatch =
        (localKey === teamAKey && visitorKey === teamBKey) ||
        (localKey === teamBKey && visitorKey === teamAKey);
      if (!teamsMatch) return false;
      if (!matchDateKey) return true;
      const feedDate = parseGoalserveDateTime(item.date, item.time);
      if (!feedDate) return true;
      return feedDate.slice(0, 10) === matchDateKey;
    });

    if (!matched || !matched.tossText) continue;
    const toss = parseTossText(matched.tossText, match.teamA, match.teamB);
    if (!toss) continue;

    match.toss = toss;
    match.goalserveMatchId = matched.id || null;
    updated += 1;
  }

  data.settings.lastTossSync = new Date().toISOString();
  return { updated, checked: candidates.length };
}

function isInningsLocked(innings) {
  if (!innings) return true;
  if (innings.status === "locked" || innings.status === "scored") return true;
  if (innings.status === "open" && innings.lockTime) {
    const now = Date.now();
    const lock = new Date(innings.lockTime).getTime();
    if (!Number.isNaN(lock) && now >= lock) return true;
  }
  return false;
}

function normalizeInningsStatus(innings) {
  if (!innings) return;
  if (innings.status === "open" && isInningsLocked(innings)) {
    innings.status = "locked";
  }
}

function getBattingTeams(match) {
  if (!match.toss || !match.toss.winner || !match.toss.decision) return null;
  const winner = match.toss.winner;
  const decision = match.toss.decision;
  const other = winner === match.teamA ? match.teamB : match.teamA;
  if (decision === "bat") {
    return { innings1: winner, innings2: other };
  }
  if (decision === "field") {
    return { innings1: other, innings2: winner };
  }
  return null;
}

function normalizeMatch(match, settings) {
  if (!match.innings1) {
    match.innings1 = {
      status: match.status || "open",
      lockTime: match.lockTime || null,
      score: match.actualScore ?? null
    };
  }
  if (!match.innings2) {
    match.innings2 = {
      status: "pending",
      lockTime: match.innings2LockTime || null,
      score: match.innings2Score ?? null
    };
  }

  if (!match.predictions || typeof match.predictions !== "object" || Array.isArray(match.predictions)) {
    match.predictions = {};
  }
  if (!match.predictions.innings1 && !match.predictions.innings2) {
    const legacy = match.predictions;
    match.predictions = { innings1: legacy || {}, innings2: {} };
  }
  match.predictions.innings1 = match.predictions.innings1 || {};
  match.predictions.innings2 = match.predictions.innings2 || {};

  if (!match.toss) {
    match.toss = null;
  }

  if (match.innings1.status === "scored" && match.innings2.status === "pending") {
    match.innings2.status = "open";
    if (!match.innings2.lockTime && match.innings1.lockTime && settings?.lockMinutesBeforeStart) {
      match.innings2.lockTime = null;
    }
  }

  normalizeInningsStatus(match.innings1);
  normalizeInningsStatus(match.innings2);
}

function computeInningsResult(actualScore, predictions, players) {
  if (actualScore == null) return null;
  const entries = [];
  for (const player of players) {
    const prediction = predictions[player.id];
    if (prediction == null) continue;
    const diff = Math.abs(prediction - actualScore);
    entries.push({ playerId: player.id, diff });
  }
  if (entries.length === 0) {
    return { winners: [], closestDiff: null };
  }
  const minDiff = Math.min(...entries.map((e) => e.diff));
  const winners = entries.filter((e) => e.diff === minDiff).map((e) => e.playerId);
  return { winners, closestDiff: minDiff };
}

function buildScoreboard(data) {
  const stats = new Map();
  for (const player of data.players) {
    stats.set(player.id, {
      playerId: player.id,
      name: player.name,
      wins: 0,
      exactHits: 0,
      points: 0,
      totalDiff: 0,
      predictions: 0,
      scoredMatches: 0
    });
  }

  for (const match of data.matches) {
    for (const inningsKey of ["innings1", "innings2"]) {
      const innings = match[inningsKey];
      if (!innings || innings.status !== "scored" || innings.score == null) continue;
      const predictions = match.predictions?.[inningsKey] || {};
      const result =
        match.result?.[inningsKey] || computeInningsResult(innings.score, predictions, data.players);
      const winnerSet = new Set(result ? result.winners : []);
      const diffs = [];

      for (const player of data.players) {
        const prediction = predictions[player.id];
        if (prediction == null) continue;
        const diff = Math.abs(prediction - innings.score);
        diffs.push({ playerId: player.id, diff });
        const row = stats.get(player.id);
        row.totalDiff += diff;
        row.predictions += 1;
        row.scoredMatches += 1;
        if (diff === 0) row.exactHits += 1;
      }

      for (const entry of diffs) {
        const row = stats.get(entry.playerId);
        if (winnerSet.has(entry.playerId)) {
          row.wins += 1;
          row.points += 1;
          if (entry.diff === 0 && data.settings.bonusExact > 0) {
            row.points += data.settings.bonusExact;
          }
        }
      }
    }
  }

  const rows = Array.from(stats.values()).map((row) => ({
    ...row,
    avgDiff: row.predictions ? Number((row.totalDiff / row.predictions).toFixed(2)) : null
  }));

  rows.sort((a, b) => b.points - a.points || a.avgDiff - b.avgDiff || a.name.localeCompare(b.name));
  return rows;
}

app.get("/api/state", async (req, res) => {
  const data = await readData();
  data.matches.forEach((match) => normalizeMatch(match, data.settings));
  try {
    await syncTossFromGoalserve(data, false);
  } catch (err) {
    // Keep state available even if toss sync fails.
  }
  await saveData(data);
  const { adminPinHash, ...settings } = data.settings;
  res.json({
    settings,
    players: data.players,
    matches: data.matches,
    scoreboard: buildScoreboard(data)
  });
});

app.post("/api/setup", async (req, res) => {
  const body = req.body || {};
  const roomName = String(body.roomName || "T20 Score Predictions").trim();
  const playerNames = Array.isArray(body.players) ? body.players : [];
  const uniqueNames = playerNames
    .map((name) => String(name || "").trim())
    .filter(Boolean);

  if (uniqueNames.length < 4) {
    return res.status(400).json({ error: "Add four players." });
  }

  const usePin = Boolean(body.usePin);
  const adminPin = String(body.adminPin || "").trim();
  if (usePin && adminPin.length < 3) {
    return res.status(400).json({ error: "Admin PIN must be at least 3 digits." });
  }

  const bonusExact = Math.max(0, Number(body.bonusExact || 0));
  const minScore = Math.max(0, Number(body.minScore || 60));
  const maxScore = Math.max(minScore, Number(body.maxScore || 300));
  const lockMinutesBeforeStart = Math.max(0, Number(body.lockMinutesBeforeStart || 15));
  const importScheduleNow = Boolean(body.importSchedule);

  const data = defaultData();
  data.settings.roomName = roomName;
  data.settings.usePin = usePin;
  data.settings.adminPinHash = usePin ? hashPin(adminPin) : null;
  data.settings.bonusExact = bonusExact;
  data.settings.minScore = minScore;
  data.settings.maxScore = maxScore;
  data.settings.lockMinutesBeforeStart = lockMinutesBeforeStart;
  data.players = uniqueNames.map((name) => ({ id: makeId("player"), name }));

  let scheduleResult = null;
  let scheduleError = null;
  if (importScheduleNow) {
    try {
      scheduleResult = await importSchedule(data);
    } catch (err) {
      scheduleError = err.message || "Schedule sync failed.";
    }
  }

  await saveData(data);
  res.json({ ok: true, scheduleResult, scheduleError });
});

app.post("/api/schedule/import", async (req, res) => {
  const data = await readData();
  if (!ensureAdmin(data, req.body?.adminPin)) {
    return res.status(403).json({ error: "Invalid admin PIN." });
  }

  try {
    data.matches.forEach((match) => normalizeMatch(match, data.settings));
    const result = await importSchedule(data);
    await saveData(data);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message || "Schedule sync failed." });
  }
});

app.post("/api/toss/sync", async (req, res) => {
  const data = await readData();
  if (!ensureAdmin(data, req.body?.adminPin)) {
    return res.status(403).json({ error: "Invalid admin PIN." });
  }
  try {
    const result = await syncTossFromGoalserve(data, true);
    await saveData(data);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message || "Toss sync failed." });
  }
});

app.post("/api/matches", async (req, res) => {
  const data = await readData();
  const body = req.body || {};
  if (!ensureAdmin(data, body.adminPin)) {
    return res.status(403).json({ error: "Invalid admin PIN." });
  }

  const teamA = String(body.teamA || "").trim();
  const teamB = String(body.teamB || "").trim();
  if (!teamA || !teamB) {
    return res.status(400).json({ error: "Provide both team names." });
  }

  const matchDate = body.matchDate ? new Date(body.matchDate).toISOString() : null;
  const lockTime = body.lockTime
    ? new Date(body.lockTime).toISOString()
    : computeLockTime(matchDate, data.settings.lockMinutesBeforeStart);

  const match = {
    id: makeId("match"),
    externalId: null,
    matchNumber: null,
    roundNumber: null,
    venue: body.venue ? String(body.venue).trim() : null,
    group: body.group ? String(body.group).trim() : null,
    stage: body.stage ? String(body.stage).trim() : "Custom",
    teamA,
    teamB,
    matchDate,
    innings1: {
      status: "open",
      lockTime,
      score: null
    },
    innings2: {
      status: "pending",
      lockTime: null,
      score: null
    },
    predictions: { innings1: {}, innings2: {} },
    result: null,
    toss: null
  };

  data.matches.push(match);
  await saveData(data);
  res.json({ ok: true, match });
});

app.post("/api/matches/:id/predict", async (req, res) => {
  const data = await readData();
  const match = data.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match not found." });

  normalizeMatch(match, data.settings);
  const body = req.body || {};
  const innings = Number(body.innings || 1);
  const inningsKey = innings === 2 ? "innings2" : "innings1";
  const inningsData = match[inningsKey];

  const battingTeams = getBattingTeams(match);
  if (!battingTeams) {
    return res.status(400).json({ error: "Set the toss before predictions." });
  }

  if (!inningsData || inningsData.status !== "open") {
    return res.status(403).json({ error: "Predictions are not open for this innings." });
  }

  if (isInningsLocked(inningsData)) {
    await saveData(data);
    return res.status(403).json({ error: "Predictions are locked." });
  }

  const playerId = String(body.playerId || "");
  const score = Number(body.score);

  if (!data.players.find((p) => p.id === playerId)) {
    return res.status(400).json({ error: "Invalid player." });
  }

  if (!Number.isFinite(score) || score < data.settings.minScore || score > data.settings.maxScore) {
    return res.status(400).json({
      error: `Score must be between ${data.settings.minScore} and ${data.settings.maxScore}.`
    });
  }

  match.predictions[inningsKey][playerId] = Math.round(score);
  await saveData(data);
  res.json({ ok: true });
});

app.post("/api/matches/:id/lock", async (req, res) => {
  const data = await readData();
  const match = data.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (!ensureAdmin(data, req.body.adminPin)) {
    return res.status(403).json({ error: "Invalid admin PIN." });
  }

  normalizeMatch(match, data.settings);
  const innings = Number(req.body.innings || 1);
  const inningsKey = innings === 2 ? "innings2" : "innings1";
  match[inningsKey].status = "locked";
  await saveData(data);
  res.json({ ok: true });
});

app.post("/api/matches/:id/toss", async (req, res) => {
  const data = await readData();
  const match = data.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (!ensureAdmin(data, req.body.adminPin)) {
    return res.status(403).json({ error: "Invalid admin PIN." });
  }

  const winner = String(req.body.winner || "");
  const decision = String(req.body.decision || "");
  if (![match.teamA, match.teamB].includes(winner)) {
    return res.status(400).json({ error: "Toss winner must be Team A or Team B." });
  }
  if (!["bat", "field"].includes(decision)) {
    return res.status(400).json({ error: "Decision must be bat or field." });
  }

  match.toss = { winner, decision };
  await saveData(data);
  res.json({ ok: true });
});

app.post("/api/matches/:id/score", async (req, res) => {
  const data = await readData();
  const match = data.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (!ensureAdmin(data, req.body.adminPin)) {
    return res.status(403).json({ error: "Invalid admin PIN." });
  }

  normalizeMatch(match, data.settings);
  const innings = Number(req.body.innings || 1);
  const inningsKey = innings === 2 ? "innings2" : "innings1";
  const score = Number(req.body.actualScore);

  if (!Number.isFinite(score) || score < data.settings.minScore || score > data.settings.maxScore) {
    return res.status(400).json({
      error: `Actual score must be between ${data.settings.minScore} and ${data.settings.maxScore}.`
    });
  }

  const inningsData = match[inningsKey];
  if (inningsKey === "innings2" && inningsData.status === "pending") {
    return res.status(400).json({ error: "Innings 2 is not open yet." });
  }
  inningsData.score = Math.round(score);
  inningsData.status = "scored";
  match.result = match.result || {};
  match.result[inningsKey] = computeInningsResult(
    inningsData.score,
    match.predictions[inningsKey],
    data.players
  );

  if (inningsKey === "innings1" && match.innings2.status === "pending") {
    match.innings2.status = "open";
    const innings2StartTime = req.body.innings2StartTime
      ? new Date(req.body.innings2StartTime).toISOString()
      : null;
    if (innings2StartTime) {
      match.innings2.lockTime = computeLockTime(
        innings2StartTime,
        data.settings.lockMinutesBeforeStart
      );
    }
  }

  await saveData(data);
  res.json({ ok: true });
});

app.post("/api/matches/:id/reopen", async (req, res) => {
  const data = await readData();
  const match = data.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match not found." });
  if (!ensureAdmin(data, req.body.adminPin)) {
    return res.status(403).json({ error: "Invalid admin PIN." });
  }

  normalizeMatch(match, data.settings);
  const innings = req.body.innings ? Number(req.body.innings) : null;
  if (innings === 1 || innings === 2) {
    const inningsKey = innings === 2 ? "innings2" : "innings1";
    match[inningsKey].status = "open";
    match[inningsKey].score = null;
    if (match.result) match.result[inningsKey] = null;
  } else {
    match.innings1.status = "open";
    match.innings1.score = null;
    match.innings2.status = "pending";
    match.innings2.score = null;
    match.innings2.lockTime = null;
    match.result = null;
  }

  await saveData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`T20 predictor running on http://localhost:${PORT}`);
});
