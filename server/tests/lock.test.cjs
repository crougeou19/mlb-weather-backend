const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../app.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const startupCall = /^startup\(\);$/gm;
assert.equal([...source.matchAll(startupCall)].length, 1, "test harness must disable exactly one startup call");
const compiled = ts.transpileModule(
  source.replace(startupCall, "/* startup is driven explicitly by the test harness */"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } },
).outputText;

// Evaluate the real backend module, not a duplicate implementation of its lock rules.
// Only the automatic startup side effect is disabled; tests drive load/lock/settle directly.
const instrumented = `${compiled}
globalThis.backendUnderTest = {
  upsertPregameDraft, lockDuePredictions, loadFromRedis, saveToRedis,
  settlePredictions, settleNFLPredictions,
  mlb: () => predictionStore, nfl: () => nflPredictionStore,
  stats: () => ({ seasonWins, seasonLosses, seasonPushes, nflSeasonWins, nflSeasonLosses, nflSeasonPushes }),
  app
};`;

const respond = (body, ok = true) => ({ ok, json: async () => body });

function harness(now, redis = new Map()) {
  const clock = { now: Date.parse(now) };
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock.now]));
    }
    static now() { return clock.now; }
  }
  const responses = { mlb: null, nfl: null };
  const fetch = async (url, options = {}) => {
    const address = String(url);
    if (address.startsWith("https://redis.test/")) {
      const [, action, key] = new URL(address).pathname.split("/");
      if (action === "get") return respond({ result: redis.get(key) ?? null });
      if (action === "set") {
        redis.set(key, JSON.parse(options.body).value);
        return respond({ result: "OK" });
      }
    }
    if (address.startsWith("https://statsapi.mlb.com/api/v1/schedule?")) return respond(responses.mlb ?? { dates: [] });
    if (address === "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard") {
      return respond(responses.nfl ?? { events: [] });
    }
    throw new Error(`Unexpected network request: ${address}`);
  };
  const context = vm.createContext({
    exports: {}, require: createRequire(sourcePath), fetch, Date: ClockDate,
    Map, Object, Array, Promise, console: { log() {}, error(...args) { throw new Error(args.join(" ")); } },
    process: { env: { UPSTASH_REDIS_REST_URL: "https://redis.test", UPSTASH_REDIS_REST_TOKEN: "test" } },
  });
  vm.runInContext(instrumented, context, { filename: sourcePath });
  const api = context.backendUnderTest;
  return {
    api, redis, responses,
    setTime(iso) { clock.now = Date.parse(iso); },
    // Invoke the registered results handlers without opening a real network listener.
    results(route) {
      const layer = api.app._router.stack.find(item => item.route?.path === route);
      assert.ok(layer, `${route} route must exist`);
      let body;
      layer.route.stack[0].handle({}, { json(value) { body = value; } });
      return JSON.parse(JSON.stringify(body));
    },
  };
}

function draft(gameId, commenceTime, changes = {}) {
  return {
    gameId, commenceTime, date: commenceTime.slice(0, 10),
    homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals",
    predictedPlay: "UNDER", confidence: "LOW", total: 8.5,
    modelProjection: 7.2, edge: { score: -5, play: "UNDER", confidence: "LOW", adjustedTotal: 7.2 },
    bookmaker: "DraftKings", homeMoneyline: -110, awayMoneyline: 100,
    settled: false, ...changes,
  };
}

function nflDraft(gameId, commenceTime, changes = {}) {
  return draft(gameId, commenceTime, {
    homeTeam: "Green Bay Packers", awayTeam: "Chicago Bears",
    homeSpread: -3.5, awaySpread: 3.5, ...changes,
  });
}

function mlbFinal(gameDate, homeScore, awayScore) {
  return {
    gameDate, status: { abstractGameState: "Final", detailedState: "Final" },
    teams: {
      home: { team: { name: "Chicago Cubs" }, score: homeScore },
      away: { team: { name: "St. Louis Cardinals" }, score: awayScore },
    },
  };
}

function nflFinal(date, homeScore, awayScore) {
  return {
    date, competitions: [{
      status: { type: { name: "STATUS_FINAL" } },
      competitors: [
        { homeAway: "home", team: { displayName: "Green Bay Packers" }, score: String(homeScore) },
        { homeAway: "away", team: { displayName: "Chicago Bears" }, score: String(awayScore) },
      ],
    }],
  };
}

test("MLB drafts can change repeatedly before start, then freeze exactly at start", async () => {
  const start = "2026-09-23T18:00:00Z";
  const h = harness("2026-09-23T15:00:00Z");
  const store = h.api.mlb();
  const low = draft("mlb-1", start);
  const medium = draft("mlb-1", start, {
    predictedPlay: "OVER", confidence: "MEDIUM", total: 9,
    modelProjection: 10.1, edge: { score: 19, play: "OVER", adjustedTotal: 10.1 },
  });
  const high = draft("mlb-1", start, {
    predictedPlay: "UNDER", confidence: "HIGH", total: 7.5,
    modelProjection: 5.9, edge: { score: -31, play: "UNDER", adjustedTotal: 5.9 },
    bookmaker: "FanDuel", homeMoneyline: -130,
  });
  assert.equal(h.api.upsertPregameDraft(store, low), true);
  h.setTime("2026-09-23T17:00:00Z");
  assert.equal(h.api.upsertPregameDraft(store, medium), true);
  assert.equal(store.get("mlb-1").confidence, "MEDIUM");
  h.setTime("2026-09-23T17:59:59.999Z");
  assert.equal(h.api.upsertPregameDraft(store, high), true);
  await h.api.lockDuePredictions();
  assert.equal(store.get("mlb-1").isLocked, false);
  h.setTime(start);
  await h.api.lockDuePredictions();
  const locked = JSON.parse(JSON.stringify(store.get("mlb-1")));
  assert.equal(locked.lockedAt, start.replace("Z", ".000Z"));
  assert.equal(locked.lockRecordedAt, locked.lockedAt);
  assert.equal(locked.isLocked, true);
  for (const key of ["predictedPlay", "confidence", "total", "modelProjection", "edge", "bookmaker", "homeMoneyline"]) {
    assert.deepEqual(locked[key], high[key], `${key} must match the last pregame snapshot`);
  }
  assert.equal(h.api.upsertPregameDraft(store, medium), false);
  h.setTime("2026-09-23T18:15:00Z");
  assert.equal(h.api.upsertPregameDraft(store, low), false);
  await h.api.lockDuePredictions();
  assert.deepEqual(JSON.parse(JSON.stringify(store.get("mlb-1"))), locked);
  assert.deepEqual(redisRecord(h.redis, "predictions", "mlb-1"), locked);
});

function redisRecord(redis, collection, gameId) {
  return JSON.parse(redis.get(collection))[gameId];
}

test("post-start drafts cannot create a retroactive official pick, even before the timer fires", async () => {
  const h = harness("2026-09-23T18:00:00Z");
  const store = h.api.mlb();
  assert.equal(h.api.upsertPregameDraft(store, draft("late", "2026-09-23T18:00:00Z")), false);
  assert.equal(store.has("late"), false);
  h.setTime("2026-09-23T18:00:01Z");
  assert.equal(h.api.upsertPregameDraft(store, draft("late", "2026-09-23T18:00:00Z")), false);
});

test("a backend restart after kickoff restores the MLB snapshot from Redis", async () => {
  const start = "2026-09-23T18:00:00Z";
  const first = harness("2026-09-23T17:50:00Z");
  first.api.upsertPregameDraft(first.api.mlb(), draft("persisted", start, { confidence: "HIGH", total: 7.5 }));
  await first.api.saveToRedis();
  // Simulate process loss before its lock timer; startup loads the last pregame draft and locks it.
  const restarted = harness("2026-09-23T19:00:00Z", first.redis);
  await restarted.api.loadFromRedis();
  await restarted.api.lockDuePredictions();
  const locked = JSON.parse(JSON.stringify(restarted.api.mlb().get("persisted")));
  assert.equal(locked.confidence, "HIGH");
  assert.equal(locked.total, 7.5);
  assert.equal(locked.lockedAt, "2026-09-23T18:00:00.000Z");
  assert.equal(locked.lockRecordedAt, "2026-09-23T19:00:00.000Z");
  assert.deepEqual(redisRecord(first.redis, "predictions", "persisted"), locked);
  const again = harness("2026-09-23T20:00:00Z", first.redis);
  await again.api.loadFromRedis();
  assert.equal(again.api.upsertPregameDraft(again.api.mlb(), draft("persisted", start)), false);
  await again.api.lockDuePredictions();
  assert.deepEqual(JSON.parse(JSON.stringify(again.api.mlb().get("persisted"))), locked);
});

test("MLB doubleheaders lock separately by stable ID and are graded against the matching start", async () => {
  const firstStart = "2026-09-23T17:00:00Z";
  const secondStart = "2026-09-23T23:00:00Z";
  const h = harness("2026-09-23T16:00:00Z");
  const store = h.api.mlb();
  h.api.upsertPregameDraft(store, draft("game-1", firstStart, { predictedPlay: "OVER", total: 7.5 }));
  h.api.upsertPregameDraft(store, draft("game-2", secondStart, { predictedPlay: "UNDER", confidence: "HIGH", total: 9.5 }));
  h.setTime(firstStart);
  await h.api.lockDuePredictions();
  assert.equal(store.get("game-1").lockedAt, "2026-09-23T17:00:00.000Z");
  assert.equal(store.get("game-2").isLocked, false);
  h.setTime("2026-09-23T22:00:00Z");
  assert.equal(h.api.upsertPregameDraft(store, draft("game-2", secondStart, { predictedPlay: "UNDER", total: 8.5 })), true);
  h.setTime(secondStart);
  await h.api.lockDuePredictions();
  assert.equal(store.get("game-2").lockedAt, "2026-09-23T23:00:00.000Z");
  assert.equal(store.get("game-2").total, 8.5);
  h.responses.mlb = { dates: [{ games: [mlbFinal(secondStart, 4, 4), mlbFinal(firstStart, 4, 4)] }] };
  h.setTime("2026-09-24T12:00:00Z");
  await h.api.settlePredictions();
  assert.equal(store.get("game-1").result, "WIN");
  assert.equal(store.get("game-2").result, "WIN");
  assert.equal(store.get("game-1").actualRuns, 8);
  assert.equal(store.get("game-2").actualRuns, 8);
});

test("NFL changes before kickoff, freezes pick and spreads, survives restart, and rejects later updates", async () => {
  const start = "2026-09-23T20:00:00Z";
  const h = harness("2026-09-23T19:00:00Z");
  const store = h.api.nfl();
  h.api.upsertPregameDraft(store, nflDraft("nfl-1", start));
  h.setTime("2026-09-23T19:59:59Z");
  const latest = nflDraft("nfl-1", start, {
    predictedPlay: "OVER", confidence: "HIGH", total: 43.5,
    modelProjection: 48, edge: { score: 18, play: "OVER", adjustedTotal: 48 },
    homeSpread: -4.5, awaySpread: 4.5, homeMoneyline: -215,
  });
  assert.equal(h.api.upsertPregameDraft(store, latest), true);
  h.setTime(start);
  await h.api.lockDuePredictions();
  const locked = JSON.parse(JSON.stringify(store.get("nfl-1")));
  for (const key of ["predictedPlay", "confidence", "total", "modelProjection", "edge", "homeSpread", "awaySpread", "homeMoneyline"]) {
    assert.deepEqual(locked[key], latest[key], `${key} must freeze at kickoff`);
  }
  assert.equal(locked.lockedAt, "2026-09-23T20:00:00.000Z");
  assert.equal(h.api.upsertPregameDraft(store, nflDraft("nfl-1", start)), false);
  const restarted = harness("2026-09-23T21:00:00Z", h.redis);
  await restarted.api.loadFromRedis();
  await restarted.api.lockDuePredictions();
  assert.deepEqual(JSON.parse(JSON.stringify(restarted.api.nfl().get("nfl-1"))), locked);
});

test("MLB settlement and /results use the locked pick/line, not post-start changes", async () => {
  const start = "2026-09-23T18:00:00Z";
  const h = harness("2026-09-23T17:00:00Z");
  const store = h.api.mlb();
  h.api.upsertPregameDraft(store, draft("settle-mlb", start, { predictedPlay: "OVER", total: 7.5, confidence: "HIGH" }));
  h.setTime(start);
  await h.api.lockDuePredictions();
  assert.equal(h.api.upsertPregameDraft(store, draft("settle-mlb", start, { predictedPlay: "UNDER", total: 9.5, confidence: "LOW" })), false);
  h.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  h.setTime("2026-09-24T12:00:00Z");
  await h.api.settlePredictions();
  assert.equal(store.get("settle-mlb").result, "WIN");
  const results = h.results("/results");
  assert.equal(results.yesterday.games.length, 1);
  assert.equal(results.yesterday.games[0].total, 7.5);
  assert.equal(results.yesterday.games[0].confidence, "HIGH");
  assert.equal(results.yesterday.high_confidence.wins, 1);
  await h.api.settlePredictions();
  assert.equal(h.api.stats().seasonWins, 1);
});

test("NFL settlement and /nfl-results use the locked pick/line exactly once", async () => {
  const start = "2026-09-23T20:00:00Z";
  const h = harness("2026-09-23T19:00:00Z");
  const store = h.api.nfl();
  h.api.upsertPregameDraft(store, nflDraft("settle-nfl", start, { predictedPlay: "UNDER", total: 45.5, confidence: "HIGH" }));
  h.setTime(start);
  await h.api.lockDuePredictions();
  assert.equal(h.api.upsertPregameDraft(store, nflDraft("settle-nfl", start, { predictedPlay: "OVER", total: 41.5 })), false);
  h.responses.nfl = { events: [nflFinal(start, 21, 21)] };
  h.setTime("2026-09-24T12:00:00Z");
  await h.api.settleNFLPredictions();
  assert.equal(store.get("settle-nfl").result, "WIN");
  const results = h.results("/nfl-results");
  assert.equal(results.yesterday.games.length, 1);
  assert.equal(results.yesterday.games[0].predictedPlay, "UNDER");
  assert.equal(results.yesterday.games[0].total, 45.5);
  assert.equal(results.yesterday.games[0].confidence, "HIGH");
  await h.api.settleNFLPredictions();
  assert.equal(h.api.stats().nflSeasonWins, 1);
});