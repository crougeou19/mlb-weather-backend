import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// MLB stadium coordinates for weather lookup
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

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

app.get("/games", async (req, res) => {
  try {
    // 1. Fetch today's MLB odds from TheOddsAPI
    const oddsRes = await fetch(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american`
    );

    if (!oddsRes.ok) {
      throw new Error(`Odds API error: ${oddsRes.status}`);
    }

    const oddsData = await oddsRes.json() as any[];

    // 2. For each game, fetch weather at the home team's stadium
    const games = await Promise.all(
      oddsData.map(async (game: any) => {
        const homeTeam = game.home_team;
        const awayTeam = game.away_team;
        const commenceTime = game.commence_time;

        // Get totals line
        const bookmaker = game.bookmakers?.[0];
        const totalsMarket = bookmaker?.markets?.find((m: any) => m.key === "totals");
        const overLine = totalsMarket?.outcomes?.find((o: any) => o.name === "Over");
        const total = overLine?.point ?? null;

        // Get weather for home stadium
        let weather = null;
        const stadium = STADIUM_COORDS[homeTeam];
        if (stadium && WEATHER_API_KEY) {
          try {
            const weatherRes = await fetch(
              `https://api.openweathermap.org/data/2.5/weather?lat=${stadium.lat}&lon=${stadium.lon}&appid=${WEATHER_API_KEY}&units=imperial`
            );
            if (weatherRes.ok) {
              const weatherData = await weatherRes.json() as any;
              weather = {
                stadium: stadium.name,
                temp_f: Math.round(weatherData.main.temp),
                feels_like_f: Math.round(weatherData.main.feels_like),
                humidity: weatherData.main.humidity,
                wind_mph: Math.round(weatherData.wind.speed),
                wind_deg: weatherData.wind.deg,
                condition: weatherData.weather?.[0]?.description ?? "unknown",
              };
            }
          } catch (e) {
            // Weather fetch failed for this game, continue without it
          }
        }

        return {
          id: game.id,
          home_team: homeTeam,
          away_team: awayTeam,
          commence_time: commenceTime,
          total,
          weather,
        };
      })
    );

    res.json(games);
  } catch (err: any) {
    console.error("Error fetching games:", err.message);
    res.status(500).json({ error: "Failed to fetch games data", details: err.message });
  }
});

export default app;
