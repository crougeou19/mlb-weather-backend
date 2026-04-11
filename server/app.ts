import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

// 🔥 Your games route (edit later with real data)
app.get("/games", async (req, res) => {
  try {
    // TEMP placeholder (you can plug your real API here)
    const games = [
      {
        home: "Yankees",
        away: "Marlins",
        total: 8.5
      }
    ];

    res.json(games);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch games" });
  }
});

export default app;
