import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const CACHE_DURATION_MS = 30 * 60 * 1000;
let cachedGames: any[] | null = null;
let lastCacheTime: number = 0;

// ─── UPSTASH REDIS ────────────────────────────────────────────
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key: string): Promise<any> {
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json() as any;
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) {
    return null;
  }
}

async function redisSet(key: string, value: any): Promise<void> {
  try {
    await fetch(`${REDIS_URL}/set/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    });
  } catch (e) {
    console.error("Redis set error:", e);
  }
}

// ─── RECORD TRACKER ───────────────────────────────────────────
interface PredictionRecord {
  gameId: string;
  date: string;
  homeTeam: string;
  awayTeam: string;
  predictedPlay: string;
  total: number;
  confidence: string;
  settled: boolean;
  actualRuns?: number;
  result?: "WIN" | "LOSS" | "PUSH";
}

let predictionStore: Map<string, PredictionRecord> = new Map();
let seasonWins = 0;
let seasonLosses = 0;
let seasonPushes = 0;

async function loadFromRedis() {
  try {
    console.log("Loading data from Redis...");
    const predictions = await redisGet("predictions");
    const season = await redisGet("season");

    if (predictions) {
      predictionStore = new Map(Object.entries(predictions));
      console.log(`Loaded ${predictionStore.size} predictions from Redis`);

      // Rebuild season totals from settled predictions
      seasonWins = 0;
      seasonLosses = 0;
      seasonPushes = 0;

      for (const record of predictionStore.values()) {
        if (!record.settled || !record.result) continue;
        if (record.result === "WIN") seasonWins++;
        else if (record.result === "LOSS") seasonLosses++;
        else if (record.result === "PUSH") seasonPushes++;
      }

      // ✅ If no settled predictions found, use saved season record as fallback
      if (seasonWins === 0 && seasonLosses === 0 && season) {
        seasonWins = season.wins ?? 0;
        seasonLosses = season.losses ?? 0;
        seasonPushes = season.pushes ?? 0;
        console.log(`No settled predictions found — using saved season record: ${seasonWins}W-${seasonLosses}L-${seasonPushes}P`);
      } else {
        console.log(`Rebuilt season record from predictions: ${seasonWins}W-${seasonLosses}L-${seasonPushes}P`);
      }
    } else if (season) {
      // No predictions at all — use saved season record
      seasonWins = season.wins ?? 0;
      seasonLosses = season.losses ?? 0;
      seasonPushes = season.pushes ?? 0;
      console.log(`Loaded season record from Redis: ${seasonWins}W-${seasonLosses}L-${seasonPushes}P`);
    }
  } catch (e) {
    console.error("Failed to load from Redis:", e);
  }
}

      console.log(`Rebuilt season record from predictions: ${seasonWins}W-${seasonLosses}L-${seasonPushes}P`);
    }
  } catch (e) {
    console.error("Failed to load from Redis:", e);
  }
}

async function saveToRedis() {
  try {
    const predictionsObj = Object.fromEntries(predictionStore);
    await redisSet("predictions", predictionsObj);
    await redisSet("season", { wins: seasonWins, losses: seasonLosses, pushes: seasonPushes });
    console.log(`💾 Saved ${predictionStore.size} predictions to Redis`);
  } catch (e) {
    console.error("Failed to save to Redis:", e);
  }
}

async function settlePredictions() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0];

  console.log(`Settling predictions for ${dateStr}...`);
  console.log(`Total stored predictions: ${predictionStore.size}`);

  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=linescore`
    );
    const data = await res.json() as any;
    const games = data?.dates?.[0]?.games || [];
    console.log(`Found ${games.length} MLB games for ${dateStr}`);

    let anySettled = false;

    for (const game of games) {
      const homeTeamName = game.teams?.home?.team?.name;
      const gameId = `${dateStr}_${homeTeamName?.replace(/\s+/g, '_')}`;
      const record = predictionStore.get(gameId);

      if (!record) { console.log(`No prediction found for ${gameId}`); continue; }
      if (record.settled) { console.log(`Already settled: ${gameId}`); continue; }
      if (game.status?.abstractGameState !== "Final") { console.log(`Game not final: ${gameId}`); continue; }

      const homeRuns = game.teams?.home?.score ?? 0;
      const awayRuns = game.teams?.away?.score ?? 0;
      const totalRuns = homeRuns + awayRuns;

      let result: "WIN" | "LOSS" | "PUSH" = "PUSH";
      if (record.predictedPlay === "OVER") {
        result = totalRuns > record.total ? "WIN" : totalRuns < record.total ? "LOSS" : "PUSH";
      } else if (record.predictedPlay === "UNDER") {
        result = totalRuns < record.total ? "WIN" : totalRuns > record.total ? "LOSS" : "PUSH";
      } else {
        record.settled = true;
        predictionStore.set(gameId, record);
        continue;
      }

      record.settled = true;
      record.actualRuns = totalRuns;
      record.result = result;
      predictionStore.set(gameId, record);
      anySettled = true;

      if (result === "WIN") seasonWins++;
      else if (result === "LOSS") seasonLosses++;
      else seasonPushes++;

      console.log(`✅ Settled: ${record.awayTeam} @ ${record.homeTeam} — ${record.predictedPlay} ${record.total} — Actual: ${totalRuns} — ${result}`);
    }

    const settled = Array.from(predictionStore.values()).filter(p => p.settled).length;
    console.log(`Settlement complete. Total settled: ${settled}, Season: ${seasonWins}W-${seasonLosses}L-${seasonPushes}P`);
    if (anySettled) await saveToRedis();

  } catch (err: any) {
    console.error("Error settling predictions:", err.message);
  }
}

// ─── BALLPARK FACTORS (2026) ──────────────────────────────────
const PARK_FACTORS: Record<string, { runs: number; hr: number; name: string }> = {
  "Colorado Rockies":      { runs: 124, hr: 117, name: "Coors Field" },
  "Cincinnati Reds":       { runs: 108, hr: 113, name: "Great American Ball Park" },
  "Boston Red Sox":        { runs: 107, hr: 103, name: "Fenway Park" },
  "Philadelphia Phillies": { runs: 106, hr: 108, name: "Citizens Bank Park" },
  "Texas Rangers":         { runs: 105, hr: 106, name: "Globe Life Field" },
  "Chicago Cubs":          { runs: 104, hr: 101, name: "Wrigley Field" },
  "Baltimore Orioles":     { runs: 103, hr: 105, name: "Camden Yards" },
  "Atlanta Braves":        { runs: 103, hr: 104, name: "Truist Park" },
  "Minnesota Twins":       { runs: 102, hr: 103, name: "Target Field" },
  "New York Yankees":      { runs: 102, hr: 110, name: "Yankee Stadium" },
  "Houston Astros":        { runs: 101, hr: 98,  name: "Minute Maid Park" },
  "Los Angeles Angels":    { runs: 101, hr: 102, name: "Angel Stadium" },
  "Kansas City Royals":    { runs: 100, hr: 99,  name: "Kauffman Stadium" },
  "Detroit Tigers":        { runs: 100, hr: 98,  name: "Comerica Park" },
  "Toronto Blue Jays":     { runs: 100, hr: 101, name: "Rogers Centre" },
  "Milwaukee Brewers":     { runs: 99,  hr: 97,  name: "American Family Field" },
  "Washington Nationals":  { runs: 99,  hr: 100, name: "Nationals Park" },
  "Pittsburgh Pirates":    { runs: 99,  hr: 96,  name: "PNC Park" },
  "St. Louis Cardinals":   { runs: 98,  hr: 97,  name: "Busch Stadium" },
  "Chicago White Sox":     { runs: 98,  hr: 99,  name: "Guaranteed Rate Field" },
  "New York Mets":         { runs: 97,  hr: 96,  name: "Citi Field" },
  "Cleveland Guardians":   { runs: 97,  hr: 94,  name: "Progressive Field" },
  "Tampa Bay Rays":        { runs: 97,  hr: 96,  name: "Tropicana Field" },
  "Arizona Diamondbacks":  { runs: 96,  hr: 97,  name: "Chase Field" },
  "Los Angeles Dodgers":   { runs: 96,  hr: 95,  name: "Dodger Stadium" },
  "Miami Marlins":         { runs: 95,  hr: 93,  name: "loanDepot park" },
  "Seattle Mariners":      { runs: 95,  hr: 92,  name: "T-Mobile Park" },
  "Oakland Athletics":     { runs: 94,  hr: 93,  name: "Oakland Coliseum" },
  "San Francisco Giants":  { runs: 93,  hr: 88,  name: "Oracle Park" },
  "San Diego Padres":      { runs: 92,  hr: 89,  name: "Petco Park" },
};

// ─── NFL DATA ─────────────────────────────────────────────────
const NFL_FIXED_DOME_STADIUMS = new Set([
  "Las Vegas Raiders", "Los Angeles Rams", "Los Angeles Chargers",
  "Minnesota Vikings", "New Orleans Saints", "Indianapolis Colts",
  "Detroit Lions", "Atlanta Falcons", "Houston Texans", "Arizona Cardinals",
]);

const NFL_RETRACTABLE_STADIUMS = new Set(["Dallas Cowboys"]);

const NFL_STADIUM_COORDS: Record<string, { lat: number; lon: number; name: string }> = {
  "Arizona Cardinals":    { lat: 33.5276, lon: -112.2626, name: "State Farm Stadium" },
  "Atlanta Falcons":      { lat: 33.7555, lon: -84.4009,  name: "Mercedes-Benz Stadium" },
  "Baltimore Ravens":     { lat: 39.2780, lon: -76.6227,  name: "M&T Bank Stadium" },
  "Buffalo Bills":        { lat: 42.7738, lon: -78.7870,  name: "Highmark Stadium" },
  "Carolina Panthers":    { lat: 35.2258, lon: -80.8528,  name: "Bank of America Stadium" },
  "Chicago Bears":        { lat: 41.8623, lon: -87.6167,  name: "Soldier Field" },
  "Cincinnati Bengals":   { lat: 39.0955, lon: -84.5160,  name: "Paycor Stadium" },
  "Cleveland Browns":     { lat: 41.5061, lon: -81.6995,  name: "Cleveland Browns Stadium" },
  "Dallas Cowboys":       { lat: 32.7473, lon: -97.0945,  name: "AT&T Stadium" },
  "Denver Broncos":       { lat: 39.7439, lon: -105.0201, name: "Empower Field" },
  "Detroit Lions":        { lat: 42.3400, lon: -83.0456,  name: "Ford Field" },
  "Green Bay Packers":    { lat: 44.5013, lon: -88.0622,  name: "Lambeau Field" },
  "Houston Texans":       { lat: 29.6847, lon: -95.4107,  name: "NRG Stadium" },
  "Indianapolis Colts":   { lat: 39.7601, lon: -86.1639,  name: "Lucas Oil Stadium" },
  "Jacksonville Jaguars": { lat: 30.3240, lon: -81.6373,  name: "EverBank Stadium" },
  "Kansas City Chiefs":   { lat: 39.0489, lon: -94.4839,  name: "Arrowhead Stadium" },
  "Las Vegas Raiders":    { lat: 36.0909, lon: -115.1833, name: "Allegiant Stadium" },
  "Los Angeles Chargers": { lat: 33.9534, lon: -118.3391, name: "SoFi Stadium" },
  "Los Angeles Rams":     { lat: 33.9534, lon: -118.3391, name: "SoFi Stadium" },
  "Miami Dolphins":       { lat: 25.9580, lon: -80.2389,  name: "Hard Rock Stadium" },
  "Minnesota Vikings":    { lat: 44.9737, lon: -93.2575,  name: "U.S. Bank Stadium" },
  "New England Patriots": { lat: 42.0909, lon: -71.2643,  name: "Gillette Stadium" },
  "New Orleans Saints":   { lat: 29.9511, lon: -90.0812,  name: "Caesars Superdome" },
  "New York Giants":      { lat: 40.8135, lon: -74.0745,  name: "MetLife Stadium" },
  "New York Jets":        { lat: 40.8135, lon: -74.0745,  name: "MetLife Stadium" },
  "Philadelphia Eagles":  { lat: 39.9008, lon: -75.1675,  name: "Lincoln Financial Field" },
  "Pittsburgh Steelers":  { lat: 40.4468, lon: -80.0158,  name: "Acrisure Stadium" },
  "San Francisco 49ers":  { lat: 37.4033, lon: -121.9694, name: "Levi's Stadium" },
  "Seattle Seahawks":     { lat: 47.5952, lon: -122.3316, name: "Lumen Field" },
  "Tampa Bay Buccaneers": { lat: 27.9759, lon: -82.5033,  name: "Raymond James Stadium" },
  "Tennessee Titans":     { lat: 36.1665, lon: -86.7713,  name: "Nissan Stadium" },
  "Washington Commanders":{ lat: 38.9076, lon: -76.8645,  name: "FedExField" },
};

const NFL_PARK_FACTORS: Record<string, number> = {
  "Arizona Cardinals": 100, "Atlanta Falcons": 100, "Baltimore Ravens": 98,
  "Buffalo Bills": 95, "Carolina Panthers": 99, "Chicago Bears": 96,
  "Cincinnati Bengals": 98, "Cleveland Browns": 95, "Dallas Cowboys": 102,
  "Denver Broncos": 98, "Detroit Lions": 100, "Green Bay Packers": 94,
  "Houston Texans": 100, "Indianapolis Colts": 100, "Jacksonville Jaguars": 101,
  "Kansas City Chiefs": 97, "Las Vegas Raiders": 100, "Los Angeles Chargers": 101,
  "Los Angeles Rams": 101, "Miami Dolphins": 102, "Minnesota Vikings": 100,
  "New England Patriots": 96, "New Orleans Saints": 100, "New York Giants": 97,
  "New York Jets": 97, "Philadelphia Eagles": 97, "Pittsburgh Steelers": 97,
  "San Francisco 49ers": 99, "Seattle Seahawks": 98, "Tampa Bay Buccaneers": 101,
  "Tennessee Titans": 99, "Washington Commanders": 97,
};

// ─── MLB TEAM IDS ─────────────────────────────────────────────
const MLB_TEAM_IDS: Record<string, number> = {
  "Arizona Diamondbacks": 109, "Atlanta Braves": 144, "Baltimore Orioles": 110,
  "Boston Red Sox": 111, "Chicago Cubs": 112, "Chicago White Sox": 145,
  "Cincinnati Reds": 113, "Cleveland Guardians": 114, "Colorado Rockies": 115,
  "Detroit Tigers": 116, "Houston Astros": 117, "Kansas City Royals": 118,
  "Los Angeles Angels": 108, "Los Angeles Dodgers": 119, "Miami Marlins": 146,
  "Milwaukee Brewers": 158, "Minnesota Twins": 142, "New York Mets": 121,
  "New York Yankees": 147, "Oakland Athletics": 133, "Philadelphia Phillies": 143,
  "Pittsburgh Pirates": 134, "San Diego Padres": 135, "San Francisco Giants": 137,
  "Seattle Mariners": 136, "St. Louis Cardinals": 138, "Tampa Bay Rays": 139,
  "Texas Rangers": 140, "Toronto Blue Jays": 141, "Washington Nationals": 120,
};

// ─── TEAM STATS CACHE ─────────────────────────────────────────
interface TeamStats {
  teamId: number;
  runsPerGame: number;
  last10RunsPerGame: number;
  bullpenEra: number;
  gamesPlayed: number;
}

const teamStatsCache: Map<string, { data: TeamStats; time: number }> = new Map();
const TEAM_STATS_TTL = 3 * 60 * 60 * 1000;

async function fetchTeamStats(teamName: string): Promise<TeamStats | null> {
  const cached = teamStatsCache.get(teamName);
  if (cached && Date.now() - cached.time < TEAM_STATS_TTL) return cached.data;

  const teamId = MLB_TEAM_IDS[teamName];
  if (!teamId) return null;

  try {
    const season = new Date().getFullYear();

    const hittingRes = await fetch(
      `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`
    );
    const hittingData = await hittingRes.json() as any;
    const hitting = hittingData?.stats?.[0]?.splits?.[0]?.stat;
    const gamesPlayed = parseInt(hitting?.gamesPlayed ?? "1");
    const runsScored = parseInt(hitting?.runs ?? "0");
    const runsPerGame = gamesPlayed > 0 ? runsScored / gamesPlayed : 4.5;

    const last10Res = await fetch(
      `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=lastXGames&group=hitting&season=${season}&limit=10`
    );
    const last10Data = await last10Res.json() as any;
    const last10 = last10Data?.stats?.[0]?.splits?.[0]?.stat;
    const last10Games = parseInt(last10?.gamesPlayed ?? "10");
    const last10Runs = parseInt(last10?.runs ?? "0");
    const last10RunsPerGame = last10Games > 0 ? last10Runs / last10Games : runsPerGame;

    const bullpenRes = await fetch(
      `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=pitching&season=${season}`
    );
    const bullpenData = await bullpenRes.json() as any;
    const pitching = bullpenData?.stats?.[0]?.splits?.[0]?.stat;
    const teamEra = parseFloat(pitching?.era ?? "4.20");
    const bullpenEra = teamEra + 0.35;

    const stats: TeamStats = {
      teamId,
      runsPerGame: Number(runsPerGame.toFixed(2)),
      last10RunsPerGame: Number(last10RunsPerGame.toFixed(2)),
      bullpenEra: Number(bullpenEra.toFixed(2)),
      gamesPlayed,
    };

    teamStatsCache.set(teamName, { data: stats, time: Date.now() });
    return stats;
  } catch (err: any) {
    console.error(`Failed to fetch team stats for ${teamName}:`, err.message);
    return null;
  }
}

function calculateTeamOffenseScore(stats: TeamStats | null): number {
  if (!stats || stats.gamesPlayed < 10) return 0;
  let score = 0;
  const leagueAvg = 4.5;

  const seasonDiff = stats.runsPerGame - leagueAvg;
  if (seasonDiff > 1.0) score += 8;
  else if (seasonDiff > 0.5) score += 5;
  else if (seasonDiff > 0.2) score += 2;
  else if (seasonDiff < -1.0) score -= 8;
  else if (seasonDiff < -0.5) score -= 5;
  else if (seasonDiff < -0.2) score -= 2;

  const formDiff = stats.last10RunsPerGame - leagueAvg;
  if (formDiff > 1.0) score += 6;
  else if (formDiff > 0.5) score += 4;
  else if (formDiff > 0.2) score += 2;
  else if (formDiff < -1.0) score -= 6;
  else if (formDiff < -0.5) score -= 4;
  else if (formDiff < -0.2) score -= 2;

  return score;
}

function calculateBullpenScore(stats: TeamStats | null): number {
  if (!stats || stats.gamesPlayed < 10) return 0;
  let score = 0;

  if (stats.bullpenEra < 3.50) score -= 8;
  else if (stats.bullpenEra < 4.00) score -= 5;
  else if (stats.bullpenEra < 4.25) score -= 2;
  else if (stats.bullpenEra > 5.50) score += 8;
  else if (stats.bullpenEra > 5.00) score += 5;
  else if (stats.bullpenEra > 4.75) score += 2;

  return score;
}

// ─── PITCHER STATS ────────────────────────────────────────────
interface PitcherStats {
  name: string;
  era: number;
  fip: number;
  kPer9: number;
  hrPer9: number;
  flyBallRate: number;
  inningsPitched: number;
}

const pitcherCache: Map<string, { data: PitcherStats; time: number }> = new Map();
const PITCHER_CACHE_TTL = 60 * 60 * 1000;

async function fetchPitcherStats(playerId: number, playerName: string): Promise<PitcherStats | null> {
  const cacheKey = String(playerId);
  const cached = pitcherCache.get(cacheKey);
  if (cached && Date.now() - cached.time < PITCHER_CACHE_TTL) return cached.data;

  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=season&group=pitching&season=${new Date().getFullYear()}`
    );
    const data = await res.json() as any;
    const stats = data?.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;

    const ip = parseFloat(stats.inningsPitched ?? "0");
    const era = parseFloat(stats.era ?? "0");
    const kPer9 = parseFloat(stats.strikeoutsPer9Inn ?? "0");
    const hrPer9 = parseFloat(stats.homeRunsPer9 ?? "0");
    const bb = parseFloat(stats.baseOnBalls ?? "0");
    const hr = parseFloat(stats.homeRuns ?? "0");
    const k = parseFloat(stats.strikeOuts ?? "0");
    const fip = ip > 0 ? ((13 * hr + 3 * bb - 2 * k) / ip) + 3.10 : era;

    const pitcherStats: PitcherStats = {
      name: playerName,
      era: Number(era.toFixed(2)),
      fip: Number(fip.toFixed(2)),
      kPer9: Number(kPer9.toFixed(1)),
      hrPer9: Number(hrPer9.toFixed(2)),
      flyBallRate: 35,
      inningsPitched: ip,
    };

    pitcherCache.set(cacheKey, { data: pitcherStats, time: Date.now() });
    return pitcherStats;
  } catch (err: any) {
    console.error(`Failed to fetch pitcher stats for ${playerName}:`, err.message);
    return null;
  }
}

async function fetchProbablePitchers(date: string): Promise<Map<string, { home: any; away: any }>> {
  const map = new Map<string, { home: any; away: any }>();
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher`
    );
    const data = await res.json() as any;
    const games = data?.dates?.[0]?.games || [];
    for (const game of games) {
      const homeTeam = game.teams?.home?.team?.name;
      const homePitcher = game.teams?.home?.probablePitcher;
      const awayPitcher = game.teams?.away?.probablePitcher;
      if (homeTeam) map.set(homeTeam, { home: homePitcher, away: awayPitcher });
    }
  } catch (err: any) {
    console.error("Failed to fetch probable pitchers:", err.message);
  }
  return map;
}

function calculatePitcherScore(pitcher: PitcherStats | null): number {
  if (!pitcher || pitcher.inningsPitched < 5) return 0;
  let score = 0;

  if (pitcher.era < 2.50) score -= 12;
  else if (pitcher.era < 3.25) score -= 8;
  else if (pitcher.era < 3.75) score -= 5;
  else if (pitcher.era < 4.20) score -= 2;
  else if (pitcher.era > 5.50) score += 8;
  else if (pitcher.era > 4.80) score += 5;
  else if (pitcher.era > 4.40) score += 3;

  if (pitcher.fip < 2.75) score -= 10;
  else if (pitcher.fip < 3.25) score -= 6;
  else if (pitcher.fip < 3.75) score -= 3;
  else if (pitcher.fip > 5.00) score += 7;
  else if (pitcher.fip > 4.50) score += 4;
  else if (pitcher.fip > 4.10) score += 2;

  if (pitcher.kPer9 > 11) score -= 6;
  else if (pitcher.kPer9 > 9.5) score -= 4;
  else if (pitcher.kPer9 > 8.5) score -= 2;
  else if (pitcher.kPer9 < 5.5) score += 4;
  else if (pitcher.kPer9 < 6.5) score += 2;

  if (pitcher.hrPer9 > 1.8) score += 6;
  else if (pitcher.hrPer9 > 1.4) score += 3;
  else if (pitcher.hrPer9 > 1.1) score += 1;
  else if (pitcher.hrPer9 < 0.5) score -= 4;
  else if (pitcher.hrPer9 < 0.7) score -= 2;

  if (pitcher.flyBallRate > 45) score += 4;
  else if (pitcher.flyBallRate > 40) score += 2;
  else if (pitcher.flyBallRate < 25) score -= 3;
  else if (pitcher.flyBallRate < 30) score -= 1;

  return score;
}

// ─── STADIUM DATA ─────────────────────────────────────────────
const FIXED_DOME_STADIUMS = new Set(["Tampa Bay Rays"]);

const RETRACTABLE_ROOF_STADIUMS = new Set([
  "Houston Astros", "Milwaukee Brewers", "Seattle Mariners",
  "Arizona Diamondbacks", "Texas Rangers", "Miami Marlins", "Toronto Blue Jays",
]);

const STADIUM_COORDS: Record<string, { lat: number; lon: number; name: string }> = {
  "Atlanta Braves":        { lat: 33.8907, lon: -84.4677, name: "Truist Park" },
  "Arizona Diamondbacks":  { lat: 33.4453, lon: -112.0667, name: "Chase Field" },
  "Baltimore Orioles":     { lat: 39.2838, lon: -76.6216, name: "Camden Yards" },
  "Boston Red Sox":        { lat: 42.3467, lon: -71.0972, name: "Fenway Park" },
  "Chicago Cubs":          { lat: 41.9484, lon: -87.6553, name: "Wrigley Field" },
  "Chicago White Sox":     { lat: 41.8300, lon: -87.6338, name: "Guaranteed Rate Field" },
  "Cincinnati Reds":       { lat: 39.0975, lon: -84.5061, name: "Great American Ball Park" },
  "Cleveland Guardians":   { lat: 41.4962, lon: -81.6852, name: "Progressive Field" },
  "Colorado Rockies":      { lat: 39.7559, lon: -104.9942, name: "Coors Field" },
  "Detroit Tigers":        { lat: 42.3390, lon: -83.0485, name: "Comerica Park" },
  "Houston Astros":        { lat: 29.7573, lon: -95.3555, name: "Minute Maid Park" },
  "Kansas City Royals":    { lat: 39.0517, lon: -94.4803, name: "Kauffman Stadium" },
  "Los Angeles Angels":    { lat: 33.8003, lon: -117.8827, name: "Angel Stadium" },
  "Los Angeles Dodgers":   { lat: 34.0739, lon: -118.2400, name: "Dodger Stadium" },
  "Miami Marlins":         { lat: 25.7781, lon: -80.2197, name: "loanDepot park" },
  "Milwaukee Brewers":     { lat: 43.0280, lon: -87.9712, name: "American Family Field" },
  "Minnesota Twins":       { lat: 44.9817, lon: -93.2778, name: "Target Field" },
  "New York Mets":         { lat: 40.7571, lon: -73.8458, name: "Citi Field" },
  "New York Yankees":      { lat: 40.8296, lon: -73.9262, name: "Yankee Stadium" },
  "Oakland Athletics":     { lat: 37.7516, lon: -122.2005, name: "Oakland Coliseum" },
  "Philadelphia Phillies": { lat: 39.9061, lon: -75.1665, name: "Citizens Bank Park" },
  "Pittsburgh Pirates":    { lat: 40.4469, lon: -80.0057, name: "PNC Park" },
  "San Diego Padres":      { lat: 32.7076, lon: -117.1570, name: "Petco Park" },
  "San Francisco Giants":  { lat: 37.7786, lon: -122.3893, name: "Oracle Park" },
  "Seattle Mariners":      { lat: 47.5914, lon: -122.3325, name: "T-Mobile Park" },
  "St. Louis Cardinals":   { lat: 38.6226, lon: -90.1928, name: "Busch Stadium" },
  "Tampa Bay Rays":        { lat: 27.7682, lon: -82.6534, name: "Tropicana Field" },
  "Texas Rangers":         { lat: 32.7512, lon: -97.0832, name: "Globe Life Field" },
  "Toronto Blue Jays":     { lat: 43.6414, lon: -79.3894, name: "Rogers Centre" },
  "Washington Nationals":  { lat: 38.8730, lon: -77.0074, name: "Nationals Park" },
};

const STADIUM_ORIENTATIONS: Record<string, number> = {
  "Atlanta Braves": 30, "Arizona Diamondbacks": 0, "Baltimore Orioles": 75,
  "Boston Red Sox": 85, "Chicago Cubs": 95, "Chicago White Sox": 135,
  "Cincinnati Reds": 20, "Cleveland Guardians": 15, "Colorado Rockies": 20,
  "Detroit Tigers": 25, "Houston Astros": 0, "Kansas City Royals": 10,
  "Los Angeles Angels": 220, "Los Angeles Dodgers": 30, "Miami Marlins": 0,
  "Milwaukee Brewers": 0, "Minnesota Twins": 100, "New York Mets": 180,
  "New York Yankees": 195, "Oakland Athletics": 45, "Philadelphia Phillies": 65,
  "Pittsburgh Pirates": 10, "San Diego Padres": 20, "San Francisco Giants": 55,
  "Seattle Mariners": 0, "St. Louis Cardinals": 100, "Tampa Bay Rays": 0,
  "Texas Rangers": 0, "Toronto Blue Jays": 0, "Washington Nationals": 195,
};

function getWindType(windDeg: number, stadiumOrientation: number): "OUT" | "IN" | "CROSS" {
  const relative = ((windDeg - stadiumOrientation) + 360) % 360;
  if (relative >= 315 || relative <= 45) return "OUT";
  if (relative >= 135 && relative <= 225) return "IN";
  return "CROSS";
}

function adjustTempForGameTime(temp: number, commenceTime: string): number {
  try {
    const gameHour = new Date(commenceTime).getHours();
    if (gameHour >= 17) {
      const hoursPastNoon = gameHour - 12;
      const tempDrop = Math.min(hoursPastNoon * 1.5, 12);
      return Math.round(temp - tempDrop);
    }
    return temp;
  } catch (e) {
    return temp;
  }
}

// ─── EASTERN TIME DATE HELPERS ────────────────────────────────
function getTodayET(): { start: Date; end: Date; dateStr: string } {
  const nowET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const start = new Date(`${nowET}T00:00:00-04:00`);
  const end = new Date(`${nowET}T23:59:59-04:00`);
  return { start, end, dateStr: nowET };
}

function calculateEdge({
  windSpeed, windType, temp, humidity, total,
  isFixedDome, isRetractable,
  homePitcherScore, awayPitcherScore,
  parkFactor, homeOffenseScore, awayOffenseScore,
  homeBullpenScore, awayBullpenScore,
}: {
  windSpeed: number; windType: "OUT" | "IN" | "CROSS";
  temp: number; humidity: number; total: number;
  isFixedDome: boolean; isRetractable: boolean;
  homePitcherScore: number; awayPitcherScore: number;
  parkFactor: number; homeOffenseScore: number; awayOffenseScore: number;
  homeBullpenScore: number; awayBullpenScore: number;
}) {
  let score = 0;

  if (!isFixedDome) {
    if (windType === "OUT") score += windSpeed * 1.5;
    if (windType === "IN") score -= windSpeed * 1.5;
    if (windSpeed >= 12) score *= 1.2;
    if (windSpeed >= 15) score *= 1.4;

    if (temp >= 85) score += 8;
    else if (temp >= 75) score += 5;
    else if (temp <= 50) score -= 8;
    else if (temp <= 60) score -= 5;

    if (humidity < 40) score += 3;
    if (humidity > 70) score -= 3;
    if (temp >= 85 && humidity < 50) score += 5;
  }

  const pitcherScore = (homePitcherScore + awayPitcherScore) / 2;
  score += pitcherScore;
  const bullpenScore = (homeBullpenScore + awayBullpenScore) / 2;
  score += bullpenScore;
  const offenseScore = (homeOffenseScore + awayOffenseScore) / 2;
  score += offenseScore;
  const parkScore = (parkFactor - 100) * 0.25;
  score += parkScore;

  const runsAdded = score / 20;
  const adjustedTotal = total + runsAdded;

  // ✅ Sanity check — if adjusted total is unrealistic, cap it
  const safeAdjustedTotal = Math.max(
    Math.min(adjustedTotal, total + 4),
    Math.max(total - 4, 1)
  );

  let play = "NO EDGE";
  let confidence = "LOW";
  if (score >= 28) { play = "OVER"; confidence = "HIGH"; }
  else if (score >= 16) { play = "OVER"; confidence = "MEDIUM"; }
  else if (score <= -28) { play = "UNDER"; confidence = "HIGH"; }
  else if (score <= -16) { play = "UNDER"; confidence = "MEDIUM"; }

  return {
    score: Math.round(score), play, confidence,
    runsAdded: Number(runsAdded.toFixed(1)),
    adjustedTotal: Number(safeAdjustedTotal.toFixed(1)),
    isFixedDome, isRetractable,
    breakdown: {
      pitcherScore: Math.round(pitcherScore),
      bullpenScore: Math.round(bullpenScore),
      offenseScore: Math.round(offenseScore),
      parkScore: Math.round(parkScore),
    },
    parkFactor,
  };
}

function calculateNFLEdge({ windSpeed, windType, temp, humidity, precipitation, total, isFixedDome, isRetractable, parkFactor }: {
  windSpeed: number; windType: "OUT" | "IN" | "CROSS"; temp: number;
  humidity: number; precipitation: number; total: number;
  isFixedDome: boolean; isRetractable: boolean; parkFactor: number;
}) {
  let score = 0;

  if (!isFixedDome) {
    if (windSpeed >= 20) score -= 12;
    else if (windSpeed >= 15) score -= 8;
    else if (windSpeed >= 10) score -= 4;
    else if (windSpeed >= 7) score -= 2;

    if (temp <= 20) score -= 12;
    else if (temp <= 32) score -= 8;
    else if (temp <= 40) score -= 5;
    else if (temp <= 50) score -= 3;
    else if (temp >= 85) score += 3;
    else if (temp >= 75) score += 2;

    if (precipitation >= 70) score -= 10;
    else if (precipitation >= 50) score -= 6;
    else if (precipitation >= 30) score -= 3;

    if (windSpeed >= 15 && temp <= 32) score -= 6;
  }

  score += (parkFactor - 100) * 0.3;
  const pointsAdded = score / 20 * 3;
  const adjustedTotal = total + pointsAdded;

  let play = "NO EDGE";
  let confidence = "LOW";
  if (score >= 20) { play = "OVER"; confidence = "HIGH"; }
  else if (score >= 10) { play = "OVER"; confidence = "MEDIUM"; }
  else if (score <= -20) { play = "UNDER"; confidence = "HIGH"; }
  else if (score <= -10) { play = "UNDER"; confidence = "MEDIUM"; }

  let spreadLean = "NEUTRAL";
  if (!isFixedDome) {
    if (windSpeed >= 15 || temp <= 32 || precipitation >= 50) spreadLean = "UNDER and home team defense";
    else if (temp >= 75 && windSpeed < 10) spreadLean = "OVER and offensive teams";
  }

  return {
    score: Math.round(score), play, confidence,
    pointsAdded: Number(pointsAdded.toFixed(1)),
    adjustedTotal: Number(adjustedTotal.toFixed(1)),
    spreadLean, isFixedDome, isRetractable, parkFactor,
  };
}

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

app.get("/results", (req, res) => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const yesterdayResults = Array.from(predictionStore.values()).filter(
    p => p.date === yesterdayStr && p.settled && p.result
  );
  const yesterdayWins = yesterdayResults.filter(p => p.result === "WIN").length;
  const yesterdayLosses = yesterdayResults.filter(p => p.result === "LOSS").length;
  const yesterdayPushes = yesterdayResults.filter(p => p.result === "PUSH").length;
  const yesterdayTotal = yesterdayWins + yesterdayLosses;

  const allSettled = Array.from(predictionStore.values()).filter(p => p.settled && p.result);
  const highConfSettled = allSettled.filter(p => p.confidence === "HIGH");
  const highConfWins = highConfSettled.filter(p => p.result === "WIN").length;
  const highConfLosses = highConfSettled.filter(p => p.result === "LOSS").length;
  const highConfPushes = highConfSettled.filter(p => p.result === "PUSH").length;
  const highConfTotal = highConfWins + highConfLosses;

  const yesterdayHigh = yesterdayResults.filter(p => p.confidence === "HIGH");
  const yesterdayHighWins = yesterdayHigh.filter(p => p.result === "WIN").length;
  const yesterdayHighLosses = yesterdayHigh.filter(p => p.result === "LOSS").length;
  const yesterdayHighTotal = yesterdayHighWins + yesterdayHighLosses;
  const seasonTotal = seasonWins + seasonLosses;

  res.json({
    yesterday: {
      date: yesterdayStr,
      wins: yesterdayWins, losses: yesterdayLosses,
      pushes: yesterdayPushes, total: yesterdayTotal,
      pct: yesterdayTotal > 0 ? Math.round((yesterdayWins / yesterdayTotal) * 100) : null,
      games: yesterdayResults,
      high_confidence: {
        wins: yesterdayHighWins, losses: yesterdayHighLosses,
        total: yesterdayHighTotal,
        pct: yesterdayHighTotal > 0 ? Math.round((yesterdayHighWins / yesterdayHighTotal) * 100) : null,
      },
    },
    season: {
      wins: seasonWins, losses: seasonLosses,
      pushes: seasonPushes, total: seasonTotal,
      pct: seasonTotal > 0 ? Math.round((seasonWins / seasonTotal) * 100) : null,
      high_confidence: {
        wins: highConfWins, losses: highConfLosses,
        pushes: highConfPushes, total: highConfTotal,
        pct: highConfTotal > 0 ? Math.round((highConfWins / highConfTotal) * 100) : null,
      },
    },
  });
});

// ─── NFL GAMES ────────────────────────────────────────────────
app.get("/nfl-games", async (req, res) => {
  try {
    const oddsRes = await fetch(
      `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`
    );
    if (!oddsRes.ok) throw new Error(`Odds API error: ${oddsRes.status}`);
    const oddsData = await oddsRes.json() as any[];

    const { start, end } = getTodayET();
    const upcomingGames = oddsData.filter((game: any) => {
      const gameTime = new Date(game.commence_time);
      return gameTime >= start && gameTime <= end;
    });

    const games = await Promise.all(upcomingGames.map(async (game: any) => {
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      const isFixedDome = NFL_FIXED_DOME_STADIUMS.has(homeTeam);
      const isRetractable = NFL_RETRACTABLE_STADIUMS.has(homeTeam);
      const parkFactor = NFL_PARK_FACTORS[homeTeam] ?? 100;

      const bookmaker = game.bookmakers?.find((b: any) => b.key === 'draftkings')
        ?? game.bookmakers?.find((b: any) => b.key === 'fanduel')
        ?? game.bookmakers?.[0];

      const totalsMarket = bookmaker?.markets?.find((m: any) => m.key === "totals");
      const spreadsMarket = bookmaker?.markets?.find((m: any) => m.key === "spreads");
      const h2hMarket = bookmaker?.markets?.find((m: any) => m.key === "h2h");

      const total = totalsMarket?.outcomes?.find((o: any) => o.name === "Over")?.point ?? null;
      const homeSpread = spreadsMarket?.outcomes?.find((o: any) => o.name === homeTeam)?.point ?? null;
      const awaySpread = spreadsMarket?.outcomes?.find((o: any) => o.name === awayTeam)?.point ?? null;
      const homeML = h2hMarket?.outcomes?.find((o: any) => o.name === homeTeam)?.price ?? null;
      const awayML = h2hMarket?.outcomes?.find((o: any) => o.name === awayTeam)?.price ?? null;

      let weather = null;
      let edge = null;
      const stadium = NFL_STADIUM_COORDS[homeTeam];

      if (stadium && WEATHER_API_KEY) {
        try {
          const weatherRes = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?lat=${stadium.lat}&lon=${stadium.lon}&appid=${WEATHER_API_KEY}&units=imperial`
          );
          if (weatherRes.ok) {
            const wd = await weatherRes.json() as any;
            // ✅ Cap wind speed at 35mph for NFL too
            const windSpeed = Math.min(Math.round(wd.wind?.speed ?? 0), 35);
            const windType = getWindType(wd.wind?.deg ?? 0, 180);
            const precipitation = wd.pop ? Math.round(wd.pop * 100) : 0;

            weather = {
              stadium: stadium.name,
              temp_f: Math.round(wd.main.temp),
              feels_like_f: Math.round(wd.main.feels_like),
              humidity: wd.main.humidity,
              wind_mph: windSpeed,
              condition: wd.weather?.[0]?.description ?? "unknown",
              precipitation_pct: precipitation,
              isFixedDome, isRetractable,
            };

            if (total !== null) {
              edge = calculateNFLEdge({
                windSpeed, windType,
                temp: Math.round(wd.main.temp),
                humidity: wd.main.humidity,
                precipitation, total, isFixedDome, isRetractable, parkFactor,
              });
            }
          }
        } catch (e) {}
      }

      return {
        id: game.id, sport: "NFL",
        home_team: homeTeam, away_team: awayTeam,
        commence_time: game.commence_time,
        bookmaker: bookmaker?.title ?? "Unknown",
        total, home_spread: homeSpread, away_spread: awaySpread,
        home_ml: homeML, away_ml: awayML,
        weather, edge,
        park: { factor: parkFactor, name: stadium?.name ?? "Unknown", isFixedDome, isRetractable },
      };
    }));

    res.json(games);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch NFL games", details: err.message });
  }
});

// ─── NFL SCORES ───────────────────────────────────────────────
app.get("/nfl-scores", async (req, res) => {
  try {
    const espnRes = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2"
    );
    if (!espnRes.ok) throw new Error(`ESPN API error: ${espnRes.status}`);
    const data = await espnRes.json() as any;

    const games = (data.events || []).map((event: any) => {
      const competition = event.competitions?.[0];
      const home = competition?.competitors?.find((c: any) => c.homeAway === "home");
      const away = competition?.competitors?.find((c: any) => c.homeAway === "away");
      const isFinal = competition?.status?.type?.name === "STATUS_FINAL";
      return {
        gameId: event.id,
        week: data.week?.number ?? null,
        season: data.season?.year ?? null,
        homeTeam: home?.team?.displayName ?? "",
        homeAbbr: home?.team?.abbreviation ?? "",
        awayTeam: away?.team?.displayName ?? "",
        awayAbbr: away?.team?.abbreviation ?? "",
        homeScore: isFinal ? parseInt(home?.score ?? "0") : null,
        awayScore: isFinal ? parseInt(away?.score ?? "0") : null,
        homeWon: isFinal ? parseInt(home?.score ?? "0") > parseInt(away?.score ?? "0") : null,
        awayWon: isFinal ? parseInt(away?.score ?? "0") > parseInt(home?.score ?? "0") : null,
        status: isFinal ? "Final" : competition?.status?.type?.description ?? "Scheduled",
        date: event.date,
      };
    }).filter((g: any) => g.status === "Final");

    res.json({ success: true, week: data.week?.number, season: data.season?.year, games });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── MLB POOLZONE SCORES ──────────────────────────────────────
interface MLBGame {
  gameId: number; date: string;
  homeTeam: string; awayTeam: string;
  homeScore: number; awayScore: number; status: string;
}

let cachedMLBScores: MLBGame[] | null = null;
let mlbCacheTime: number = 0;
const MLB_CACHE_MS = 15 * 60 * 1000;

async function fetchMLBScores(date?: string): Promise<MLBGame[]> {
  const now = Date.now();
  if (!date && cachedMLBScores && now - mlbCacheTime < MLB_CACHE_MS) return cachedMLBScores;
  const targetDate = date || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const data = await (await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${targetDate}&hydrate=linescore`)).json() as any;
  const games: MLBGame[] = [];
  for (const dateObj of (data.dates || [])) {
    for (const game of (dateObj.games || [])) {
      const status = game.status?.detailedState || "Scheduled";
      const isFinal = status.toLowerCase().includes("final");
      const inProgress = status.toLowerCase().includes("progress");
      games.push({
        gameId: game.gamePk, date: dateObj.date,
        homeTeam: game.teams?.home?.team?.name || "",
        awayTeam: game.teams?.away?.team?.name || "",
        homeScore: isFinal || inProgress ? (game.teams?.home?.score ?? 0) : 0,
        awayScore: isFinal || inProgress ? (game.teams?.away?.score ?? 0) : 0,
        status: isFinal ? "Final" : inProgress ? "In Progress" : "Scheduled",
      });
    }
  }
  if (!date) { cachedMLBScores = games; mlbCacheTime = now; }
  return games;
}

app.get("/poolzone/mlb-scores", async (req, res) => {
  try {
    const games = await fetchMLBScores(req.query.date as string | undefined);
    res.json({ success: true, date: req.query.date || "today", games });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/poolzone/mlb-scores/range", async (req, res) => {
  try {
    const { from, to } = req.query as { from: string; to: string };
    if (!from || !to) return res.status(400).json({ success: false, error: "from and to dates required" });
    const data = await (await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${from}&endDate=${to}&hydrate=linescore`)).json() as any;
    const games: MLBGame[] = [];
    for (const dateObj of (data.dates || [])) {
      for (const game of (dateObj.games || [])) {
        if (game.status?.detailedState?.toLowerCase().includes("final")) {
          games.push({
            gameId: game.gamePk, date: dateObj.date,
            homeTeam: game.teams?.home?.team?.name || "",
            awayTeam: game.teams?.away?.team?.name || "",
            homeScore: game.teams?.home?.score ?? 0,
            awayScore: game.teams?.away?.score ?? 0,
            status: "Final",
          });
        }
      }
    }
    res.json({ success: true, from, to, games });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── VENUE STATS ──────────────────────────────────────────────
const venueStatsCache: Map<string, { data: any; time: number }> = new Map();
const VENUE_STATS_TTL = 6 * 60 * 60 * 1000;

app.get("/venue-stats", async (req, res) => {
  const homeTeam = req.query.team as string;
  const homePitcherId = req.query.homePitcherId as string;
  const awayPitcherId = req.query.awayPitcherId as string;
  const homePitcherName = req.query.homePitcherName as string;
  const awayPitcherName = req.query.awayPitcherName as string;

  if (!homeTeam) return res.status(400).json({ error: "team parameter required" });

  const cacheKey = `venue_${homeTeam}_${homePitcherId}_${awayPitcherId}`;
  const cached = venueStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.time < VENUE_STATS_TTL) return res.json(cached.data);

  try {
    const teamId = MLB_TEAM_IDS[homeTeam];
    if (!teamId) return res.status(404).json({ error: "Team not found" });

    const currentYear = new Date().getFullYear();
    const seasons = [currentYear, currentYear - 1, currentYear - 2];

    let allGames: any[] = [];
    for (const season of seasons) {
      try {
        const schedRes = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&season=${season}&gameType=R&hydrate=linescore`
        );
        const schedData = await schedRes.json() as any;
        for (const dateObj of (schedData.dates || [])) {
          for (const game of (dateObj.games || [])) {
            if (game.teams?.home?.team?.id !== teamId) continue;
            if (game.status?.abstractGameState !== "Final") continue;
            const homeScore = game.teams?.home?.score ?? 0;
            const awayScore = game.teams?.away?.score ?? 0;
            allGames.push({
              date: dateObj.date, season,
              home: game.teams?.home?.team?.name,
              away: game.teams?.away?.team?.name,
              homeScore, awayScore,
              total: homeScore + awayScore,
            });
          }
        }
      } catch (e) {}
    }

    allGames.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const last5Games = allGames.slice(0, 5);

    const avgLine = 8.5;
    let overs = 0, unders = 0, pushes = 0, totalRunsSum = 0;
    allGames.forEach(g => {
      totalRunsSum += g.total;
      if (g.total > avgLine) overs++;
      else if (g.total < avgLine) unders++;
      else pushes++;
    });

    const totalGames = allGames.length;
    const venueOURecord = {
      overs, unders, pushes, totalGames,
      overPct: totalGames > 0 ? Math.round((overs / totalGames) * 100) : null,
      avgRunsPerGame: totalGames > 0 ? Number((totalRunsSum / totalGames).toFixed(1)) : null,
      seasons: `${seasons[seasons.length - 1]}-${seasons[0]}`,
    };

    async function fetchPitcherVenueStats(
      pitcherId: string,
      pitcherName: string,
      isHomePitcher: boolean
    ) {
      if (!pitcherId) return null;
      try {
        const allVenueStarts: any[] = [];
        const seasonsToCheck = isHomePitcher ? [currentYear] : seasons;

        for (const season of seasonsToCheck) {
          try {
            const logRes = await fetch(
              `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`
            );
            const logData = await logRes.json() as any;
            const splits = logData?.stats?.[0]?.splits || [];

            for (const split of splits) {
              if (isHomePitcher) {
                if (split.isHome === true) allVenueStarts.push({ ...split, season });
              } else {
                if (split.opponent?.id === teamId) allVenueStarts.push({ ...split, season });
              }
            }
          } catch (e) {}
        }

        if (!allVenueStarts.length) return {
          name: pitcherName, startsAtVenue: 0,
          era: null, record: "No starts at this venue",
        };

        const totalIP = allVenueStarts.reduce((sum: number, s: any) =>
          sum + parseFloat(s.stat?.inningsPitched ?? "0"), 0);
        const totalER = allVenueStarts.reduce((sum: number, s: any) =>
          sum + parseInt(s.stat?.earnedRuns ?? "0"), 0);
        const wins = allVenueStarts.filter((s: any) => s.stat?.wins === 1).length;
        const losses = allVenueStarts.filter((s: any) => s.stat?.losses === 1).length;
        const totalK = allVenueStarts.reduce((sum: number, s: any) =>
          sum + parseInt(s.stat?.strikeOuts ?? "0"), 0);
        const totalHits = allVenueStarts.reduce((sum: number, s: any) =>
          sum + parseInt(s.stat?.hits ?? "0"), 0);
        const totalBB = allVenueStarts.reduce((sum: number, s: any) =>
          sum + parseInt(s.stat?.baseOnBalls ?? "0"), 0);
        const venueEra = totalIP > 0 ? Number(((totalER * 9) / totalIP).toFixed(2)) : null;
        const whip = totalIP > 0 ? Number(((totalHits + totalBB) / totalIP).toFixed(2)) : null;

        return {
          name: pitcherName,
          startsAtVenue: allVenueStarts.length,
          era: venueEra, whip, wins, losses,
          record: `${wins}-${losses}`,
          totalK, totalIP: Number(totalIP.toFixed(1)),
          seasonsLabel: isHomePitcher ? `${currentYear} season` : `${seasons[seasons.length - 1]}-${seasons[0]}`,
        };
      } catch (e: any) {
        return { name: pitcherName, startsAtVenue: 0, era: null, record: "Data unavailable" };
      }
    }

    const [homePitcherStats, awayPitcherStats] = await Promise.all([
      fetchPitcherVenueStats(homePitcherId, homePitcherName, true),
      fetchPitcherVenueStats(awayPitcherId, awayPitcherName, false),
    ]);

    const result = {
      team: homeTeam, venueOURecord, last5Games,
      pitcherVenueStats: { home: homePitcherStats, away: awayPitcherStats },
    };

    venueStatsCache.set(cacheKey, { data: result, time: Date.now() });
    res.json(result);

  } catch (err: any) {
    console.error("Venue stats error:", err.message);
    res.status(500).json({ error: "Failed to fetch venue stats", details: err.message });
  }
});

// ─── MAIN MLB GAMES ───────────────────────────────────────────
async function fetchGames() {
  const { start, end, dateStr: today } = getTodayET();
  const probablePitchers = await fetchProbablePitchers(today);

  const oddsRes = await fetch(
    `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals,h2h&oddsFormat=american`
  );
  if (!oddsRes.ok) throw new Error(`Odds API error: ${oddsRes.status}`);
  const oddsData = await oddsRes.json() as any[];

  const todayGames = oddsData.filter((game: any) => {
    const gameTime = new Date(game.commence_time);
    return gameTime >= start && gameTime <= end;
  });

  console.log(`Found ${todayGames.length} games for today (${today} ET)`);

  let newPredictionsAdded = false;

  const results = await Promise.all(
    todayGames.map(async (game: any) => {
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      const commenceTime = game.commence_time;
      const isFixedDome = FIXED_DOME_STADIUMS.has(homeTeam);
      const isRetractable = RETRACTABLE_ROOF_STADIUMS.has(homeTeam);
      const parkData = PARK_FACTORS[homeTeam] ?? { runs: 100, hr: 100, name: "Unknown" };
      const parkFactor = parkData.runs;

      const bookmaker = game.bookmakers?.find((b: any) => b.key === 'draftkings')
        ?? game.bookmakers?.find((b: any) => b.key === 'fanduel')
        ?? game.bookmakers?.[0];

      const totalsMarket = bookmaker?.markets?.find((m: any) => m.key === "totals");
      const h2hMarket = bookmaker?.markets?.find((m: any) => m.key === "h2h");
      const overLine = totalsMarket?.outcomes?.find((o: any) => o.name === "Over");

      const rawTotal = overLine?.point ?? null;
      const total = (rawTotal !== null && rawTotal >= 5.5 && rawTotal <= 13.5) ? rawTotal : null;
      if (rawTotal !== null && (rawTotal < 5.5 || rawTotal > 13.5)) {
        console.log(`⚠️ Filtered bad total for ${homeTeam}: ${rawTotal}`);
      }

      const homeML = h2hMarket?.outcomes?.find((o: any) => o.name === homeTeam)?.price ?? null;
      const awayML = h2hMarket?.outcomes?.find((o: any) => o.name === awayTeam)?.price ?? null;

      const pitchers = probablePitchers.get(homeTeam);
      let homePitcher: PitcherStats | null = null;
      let awayPitcher: PitcherStats | null = null;
      let homePitcherScore = 0;
      let awayPitcherScore = 0;

      if (pitchers?.home?.id) {
        homePitcher = await fetchPitcherStats(pitchers.home.id, pitchers.home.fullName);
        homePitcherScore = calculatePitcherScore(homePitcher);
      }
      if (pitchers?.away?.id) {
        awayPitcher = await fetchPitcherStats(pitchers.away.id, pitchers.away.fullName);
        awayPitcherScore = calculatePitcherScore(awayPitcher);
      }

      const [homeStats, awayStats] = await Promise.all([
        fetchTeamStats(homeTeam),
        fetchTeamStats(awayTeam),
      ]);

      const homeOffenseScore = calculateTeamOffenseScore(homeStats);
      const awayOffenseScore = calculateTeamOffenseScore(awayStats);
      const homeBullpenScore = calculateBullpenScore(homeStats);
      const awayBullpenScore = calculateBullpenScore(awayStats);

      let weather = null;
      let edge = null;
      const stadium = STADIUM_COORDS[homeTeam];
      const orientation = STADIUM_ORIENTATIONS[homeTeam] ?? 0;

      if (stadium && WEATHER_API_KEY) {
        try {
          const weatherRes = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?lat=${stadium.lat}&lon=${stadium.lon}&appid=${WEATHER_API_KEY}&units=imperial`
          );
          if (weatherRes.ok) {
            const wd = await weatherRes.json() as any;
            const windDeg = wd.wind?.deg ?? 0;
            // ✅ Cap wind at 35mph — anything higher is bad weather data
            const windSpeed = Math.min(Math.round(wd.wind?.speed ?? 0), 35);
            const windType = getWindType(windDeg, orientation);
            const rawTemp = Math.round(wd.main.temp);
            const adjustedTemp = adjustTempForGameTime(rawTemp, commenceTime);

            weather = {
              stadium: stadium.name,
              temp_f: rawTemp,
              adjusted_temp_f: adjustedTemp,
              feels_like_f: Math.round(wd.main.feels_like),
              humidity: wd.main.humidity,
              wind_mph: windSpeed,
              wind_deg: windDeg,
              wind_type: windType,
              condition: wd.weather?.[0]?.description ?? "unknown",
              isFixedDome, isRetractable,
            };

            if (total !== null) {
              edge = calculateEdge({
                windSpeed, windType, temp: adjustedTemp,
                humidity: wd.main.humidity,
                total, isFixedDome, isRetractable,
                homePitcherScore, awayPitcherScore, parkFactor,
                homeOffenseScore, awayOffenseScore,
                homeBullpenScore, awayBullpenScore,
              });

              const gameId = `${today}_${homeTeam.replace(/\s+/g, '_')}`;
              if (!predictionStore.has(gameId) && edge.play !== "NO EDGE") {
                predictionStore.set(gameId, {
                  gameId, date: today, homeTeam, awayTeam,
                  predictedPlay: edge.play, total,
                  confidence: edge.confidence, settled: false,
                });
                newPredictionsAdded = true;
                console.log(`📝 Stored prediction: ${awayTeam} @ ${homeTeam} — ${edge.play} ${total}`);
              }
            }
          }
        } catch (e) {}
      }

      return {
        id: game.id,
        home_team: homeTeam, away_team: awayTeam,
        commence_time: commenceTime,
        bookmaker: bookmaker?.title ?? "Unknown",
        total, home_ml: homeML, away_ml: awayML,
        weather, edge,
        park: {
          factor: parkFactor, hrFactor: parkData.hr,
          name: parkData.name,
          hitterFriendly: parkFactor > 102,
          pitcherFriendly: parkFactor < 98,
        },
        team_stats: {
          home: homeStats ? {
            runsPerGame: homeStats.runsPerGame,
            last10RunsPerGame: homeStats.last10RunsPerGame,
            bullpenEra: homeStats.bullpenEra,
          } : null,
          away: awayStats ? {
            runsPerGame: awayStats.runsPerGame,
            last10RunsPerGame: awayStats.last10RunsPerGame,
            bullpenEra: awayStats.bullpenEra,
          } : null,
        },
        pitchers: {
          home: homePitcher ? {
            id: pitchers?.home?.id,
            name: homePitcher.name, era: homePitcher.era,
            fip: homePitcher.fip, kPer9: homePitcher.kPer9,
            hrPer9: homePitcher.hrPer9,
          } : null,
          away: awayPitcher ? {
            id: pitchers?.away?.id,
            name: awayPitcher.name, era: awayPitcher.era,
            fip: awayPitcher.fip, kPer9: awayPitcher.kPer9,
            hrPer9: awayPitcher.hrPer9,
          } : null,
        },
      };
    })
  );

  if (newPredictionsAdded) await saveToRedis();
  return results;
}

app.get("/games", async (req, res) => {
  try {
    const now = Date.now();
    if (cachedGames && (now - lastCacheTime) < CACHE_DURATION_MS) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cachedGames);
    }
    const games = await fetchGames();
    cachedGames = games;
    lastCacheTime = now;
    res.setHeader("X-Cache", "MISS");
    res.json(games);
  } catch (err: any) {
    if (cachedGames) return res.json(cachedGames);
    res.status(500).json({ error: "Failed to fetch games data", details: err.message });
  }
});

async function refreshCache() {
  try {
    console.log("Background cache refresh starting...");
    const games = await fetchGames();
    cachedGames = games;
    lastCacheTime = Date.now();
    console.log(`Cache refreshed with ${games.length} games`);
  } catch (err: any) {
    console.error("Background refresh failed:", err.message);
  }
}

function scheduleSettlement() {
  const now = new Date();
  const next6am = new Date();
  next6am.setUTCHours(6, 0, 0, 0);
  if (now >= next6am) next6am.setUTCDate(next6am.getUTCDate() + 1);
  const msUntil6am = next6am.getTime() - now.getTime();
  console.log(`Settlement scheduled in ${Math.round(msUntil6am / 60000)} minutes (next 6am UTC)`);
  setTimeout(() => {
    console.log("Running daily settlement...");
    settlePredictions();
    setInterval(() => {
      console.log("Running daily settlement...");
      settlePredictions();
    }, 24 * 60 * 60 * 1000);
  }, msUntil6am);
}

async function startup() {
  await loadFromRedis();
  await refreshCache();
  setInterval(refreshCache, 30 * 60 * 1000);
  scheduleSettlement();
}

startup();

export default app;
