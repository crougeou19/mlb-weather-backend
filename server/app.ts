import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

app.get("/games", (req, res) => {
  res.json([
    {
      home: "Yankees",
      away: "Marlins",
      total: 8.5
    }
  ]);
});

export default app;
