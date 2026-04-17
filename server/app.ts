import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const CACHE_DURATION_MS = 10 * 60 * 1000;
let cachedGames: any[] | null = null;
let lastCacheTime: number = 0;

const DOMED_STADIUMS = new Set([
  "Tampa Bay Rays",
  "Toronto Blue Jays",
  "Houston Astros",
  "Milwaukee Brewers",
  "Seattle Mariners",
  "Arizona Diamondbacks",
  "Texas Rangers",
  "Miami Marlins",
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

function calculateEdge({ windSpeed, windType, temp, humidity, total, isDomed }: {
  windSpeed: number;
  windType: "OUT" | "IN" | "CROSS";
  temp: number;
  humidity: number;
  total: number;
  isDomed: boolean;
}) {
  let score = 0;

  if (!isDomed) {
    if (windType === "OUT") score += windSpeed * 1.5;
    if (windType === "IN") score -= windSpeed * 1.5;
    if (windSpeed >= 12) score *= 1.2;
    if (windSpeed >= 15) score *= 1.4;
  }

  if (temp >= 85) score += 8;
  else if (temp >= 75) score += 5;
  else if (temp <= 50) score -= 8;
  else if (temp <= 60) score -= 5;

  if (humidity < 40) score += 3;
  if (humidity > 70) score -= 3;

  if (temp >= 85 && humidity < 50) score += 5;

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
    isDomed,
  };
}

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

async function fetchGames() {
  const oddsRes = await fetch(
    `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals,h2h&oddsFormat=american`
  );
  if (!oddsRes.ok) throw new Error(`Odds API error: ${oddsRes.status}`);
  const oddsData = await oddsRes.json() as any[];

  // Filter to today and future games only
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const todayGames = oddsData.filter((game: any) => {
    const gameTime = new Date(game.commence_time);
    return gameTime >= startOfToday;
  });

  return Promise.all(
    todayGames.map(async (game: any) => {
      const homeTeam = game.home_team;
      const awayTeam = game.away_team;
      const commenceTime = game.commence_time;
      const isDomed = DOMED_STADIUMS.has(homeTeam);

      const bookmaker = game.bookmakers?.[0];
      const totalsMarket = bookmaker?.markets?.find((m: any) => m.key === "totals");
      const h2hMarket = bookmaker?.markets?.find((m: any) => m.key === "h2h");
      const overLine = totalsMarket?.outcomes?.find((o: any) => o.name === "Over");
      const total = overLine?.point ?? null;
      const homeML = h2hMarket?.outcomes?.find((o: any) => o.name === homeTeam)?.price ?? null;
      const awayML = h2hMarket?.outcomes?.find((o: any) => o.name === awayTeam)?.price ?? null;

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
              isDomed,
            };

            if (total !== null) {
              edge = calculateEdge({
                windSpeed,
                windType,
                temp: Math.round(wd.main.temp),
                humidity: wd.main.humidity,
                total,
                isDomed,
              });
            }
          }
        } catch (e) {}
      }

      return {
        id: game.id,
        home_team: homeTeam,
        away_team: awayTeam,
        commence_time: commenceTime,
        total,
        home_ml: homeML,
        away_ml: awayML,
        weather,
        edge,
      };
    })
  );
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

refreshCache();
setInterval(refreshCache, 30 * 60 * 1000);

export default app;
