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
    }
    if (season) {
      seasonWins = season.wins ?? 0;
      seasonLosses = season.losses ?? 0;
      seasonPushes = season.pushes ?? 0;
      console.log(`Loaded season record: ${seasonWins}W-${seasonLosses}L-${seasonPushes}P`);
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
// Source: Baseball Savant / FanGraphs park factors
// 100 = league average, >100 = hitter friendly, <100 = pitcher friendly
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

function calculateEdge({ windSpeed, windType, temp, humidity, total, isFixedDome, isRetractable, homePitcherScore, awayPitcherScore, parkFactor }: {
  windSpeed: number;
  windType: "OUT" | "IN" | "CROSS";
  temp: number;
  humidity: number;
  total: number;
  isFixedDome: boolean;
  isRetractable: boolean;
  homePitcherScore: number;
  awayPitcherScore: number;
  parkFactor: number;
}) {
  let score = 0;

  // ── Weather (skip for fixed dome) ──
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

  // ── Pitcher score ──
  const pitcherScore = (homePitcherScore + awayPitcherScore) / 2;
  score += pitcherScore;

  // ── Park factor adjustment ──
  // (parkFactor - 100) gives deviation from neutral
  // Scaled to max ±6 points for extreme parks like Coors (+24) or Petco (-8)
  const parkDeviation = parkFactor - 100;
  const parkScore = parkDeviation * 0.25;
  score += parkScore;

  const runsAdded = score / 20;
  const adjustedTotal = total + runsAdded;

  let play = "NO EDGE";
  let confidence = "LOW";
  if (score >= 20) { play = "OVER"; confidence = "HIGH"; }
  else if (score >= 10) { play = "OVER"; confidence = "MEDIUM"; }
  else if (score <= -20) { play = "UNDER"; confidence = "HIGH"; }
  else if (score <= -10) { play = "UNDER"; confidence = "MEDIUM"; }

  return {
    score: Math.round(score),
    play,
    confidence,
    runsAdded: Number(runsAdded.toFixed(1)),
    adjustedTotal: Number(adjustedTotal.toFixed(1)),
    isFixedDome,
    isRetractable,
    pitcherScore: Math.round(pitcherScore),
    parkScore: Math.round(parkScore),
    parkFactor,
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
      wins: yesterdayWins,
      losses: yesterdayLosses,
      pushes: yesterdayPushes,
      total: yesterdayTotal,
      pct: yesterdayTotal > 0 ? Math.round((yesterdayWins / yesterdayTotal) * 100) : null,
      games: yesterdayResults,
      high_confidence: {
        wins: yesterdayHighWins,
        losses: yesterdayHighLosses,
        total: yesterdayHighTotal,
        pct: yesterdayHighTotal > 0 ? Math.round((yesterdayHighWins / yesterdayHighTotal) * 100) : null,
      },
    },
    season: {
      wins: seasonWins,
      losses: seasonLosses,
      pushes: seasonPushes,
      total: seasonTotal,
      pct: seasonTotal > 0 ? Math.round((seasonWins / seasonTotal) * 100) : null,
      high_confidence: {
        wins: highConfWins,
        losses: highConfLosses,
        pushes: highConfPushes,
        total: highConfTotal,
        pct: highConfTotal > 0 ? Math.round((highConfWins / highConfTotal) * 100) : null,
      },
    },
  });
});

// ─── NFL SCORES (ESPN API) ────────────────────────────────────
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
      const status = competition?.status?.type?.name;
      const isFinal = status === "STATUS_FINAL";

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
    console.error("NFL scores error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── MLB SCORES (for PoolZone 13-run pool) ───────────────────
interface MLBGame {
  gameId: number;
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: string;
}

let cachedMLBScores: MLBGame[] | null = null;
let mlbCacheTime: number = 0;
const MLB_CACHE_MS = 15 * 60 * 1000;

async function fetchMLBScores(date?: string): Promise<MLBGame[]> {
  const now = Date.now();
  if (!date && cachedMLBScores && now - mlbCacheTime < MLB_CACHE_MS) return cachedMLBScores;
  const targetDate = date || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${targetDate}&hydrate=linescore`;
  const res = await fetch(url);
  const data = await res.json() as any;
  const games: MLBGame[] = [];
  for (const dateObj of (data.dates || [])) {
    for (const game of (dateObj.games || [])) {
      const status = game.status?.detailedState || "Scheduled";
      const isFinal = status.toLowerCase().includes("final");
      const inProgress = status.toLowerCase().includes("progress");
      games.push({
        gameId: game.gamePk,
        date: dateObj.date,
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
    const date = req.query.date as string | undefined;
    const games = await fetchMLBScores(date);
    res.json({ success: true, date: date || "today", games });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/poolzone/mlb-scores/range", async (req, res) => {
  try {
    const { from, to } = req.query as { from: string; to: string };
    if (!from || !to) return res.status(400).json({ success: false, error: "from and to dates required" });
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${from}&endDate=${to}&hydrate=linescore`;
    const apiRes = await fetch(url);
    const data = await apiRes.json() as any;
    const games: MLBGame[] = [];
    for (const dateObj of (data.dates || [])) {
      for (const game of (dateObj.games || [])) {
        const status = game.status?.detailedState || "";
        const isFinal = status.toLowerCase().includes("final");
        if (isFinal) {
          games.push({
            gameId: game.gamePk,
            date: dateObj.date,
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

async function fetchGames() {
  const today = new Date().toISOString().split("T")[0];
  const probablePitchers = await fetchProbablePitchers(today);

  const oddsRes = await fetch(
    `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals,h2h&oddsFormat=american`
  );
  if (!oddsRes.ok) throw new Error(`Odds API error: ${oddsRes.status}`);
  const oddsData = await oddsRes.json() as any[];

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const todayGames = oddsData.filter((game: any) => {
    const gameTime = new Date(game.commence_time);
    return gameTime >= startOfToday;
  });

  const results = await Promise.all(
    todayGames.map(async (game: any) => {
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      const commenceTime = game.commence_time;
      const isFixedDome = FIXED_DOME_STADIUMS.has(homeTeam);
      const isRetractable = RETRACTABLE_ROOF_STADIUMS.has(homeTeam);

      // Get park factor for home team
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
            const windSpeed = Math.round(wd.wind?.speed ?? 0);
            const windType = getWindType(windDeg, orientation);

            weather = {
              stadium: stadium.name,
              temp_f: Math.round(wd.main.temp),
              feels_like_f: Math.round(wd.main.feels_like),
              humidity: wd.main.humidity,
              wind_mph: windSpeed,
              wind_deg: windDeg,
              wind_type: windType,
              condition: wd.weather?.[0]?.description ?? "unknown",
              isFixedDome,
              isRetractable,
            };

            if (total !== null) {
              edge = calculateEdge({
                windSpeed,
                windType,
                temp: Math.round(wd.main.temp),
                humidity: wd.main.humidity,
                total,
                isFixedDome,
                isRetractable,
                homePitcherScore,
                awayPitcherScore,
                parkFactor,
              });

              const gameId = `${today}_${homeTeam.replace(/\s+/g, '_')}`;
              if (!predictionStore.has(gameId) && edge.play !== "NO EDGE") {
                predictionStore.set(gameId, {
                  gameId,
                  date: today,
                  homeTeam,
                  awayTeam,
                  predictedPlay: edge.play,
                  total,
                  confidence: edge.confidence,
                  settled: false,
                });
                console.log(`📝 Stored prediction: ${awayTeam} @ ${homeTeam} — ${edge.play} ${total}`);
                await saveToRedis();
              }
            }
          }
        } catch (e) {}
      }

      return {
        id: game.id,
        home_team: homeTeam,
        away_team: awayTeam,
        commence_time: commenceTime,
        bookmaker: bookmaker?.title ?? "Unknown",
        total,
        home_ml: homeML,
        away_ml: awayML,
        weather,
        edge,
        park: {
          factor: parkFactor,
          hrFactor: parkData.hr,
          name: parkData.name,
          hitterFriendly: parkFactor > 102,
          pitcherFriendly: parkFactor < 98,
        },
        pitchers: {
          home: homePitcher ? {
            name: homePitcher.name,
            era: homePitcher.era,
            fip: homePitcher.fip,
            kPer9: homePitcher.kPer9,
            hrPer9: homePitcher.hrPer9,
            flyBallRate: homePitcher.flyBallRate,
          } : null,
          away: awayPitcher ? {
            name: awayPitcher.name,
            era: awayPitcher.era,
            fip: awayPitcher.fip,
            kPer9: awayPitcher.kPer9,
            hrPer9: awayPitcher.hrPer9,
            flyBallRate: awayPitcher.flyBallRate,
          } : null,
        },
      };
    })
  );

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
