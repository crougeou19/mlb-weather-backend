const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../app.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const startupCall = /^startup\(\)\.catch\(err => \{[\s\S]*?^\}\);$/gm;
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

const respond = (body, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });

function harness(now, redis = new Map()) {
  const clock = { now: Date.parse(now) };
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock.now]));
    }
    static now() { return clock.now; }
  }
  const responses = { mlb: null, mlbByDate: new Map(), nfl: null };
  const failures = { get: new Map(), set: new Map(), mset: null };
  const writes = [];
  const operations = [];
  const mlbDates = [];
  const logs = { allowErrors: false, errors: [] };
  const fetch = async (url, options = {}) => {
    const address = String(url);
    if (address === "https://redis.test") {
      const [command, predictionsKey, predictions, seasonKey, season] = JSON.parse(options.body);
      assert.equal(command, "MSET");
      assert.deepEqual([predictionsKey, seasonKey], ["predictions", "season"]);
      const failure = failures.mset;
      if (failure instanceof Error) throw failure;
      if (failure && !failure.afterCommit) return respond(failure.body ?? { error: "unavailable" }, failure.ok ?? false);
      redis.set(predictionsKey, predictions);
      redis.set(seasonKey, season);
      writes.push(predictionsKey, seasonKey);
      operations.push("MSET");
      if (failure) return respond(failure.body ?? { error: "unavailable" }, failure.ok ?? false);
      return respond({ result: "OK" });
    }
    if (address.startsWith("https://redis.test/")) {
      const [, action, key] = new URL(address).pathname.split("/");
      const failure = failures[action]?.get(key);
      if (failure instanceof Error) throw failure;
      if (failure) return respond(failure.body ?? { error: "unavailable" }, failure.ok ?? false);
      if (action === "get") return respond({ result: redis.get(key) ?? null });
      if (action === "set") {
        writes.push(key);
        redis.set(key, JSON.parse(options.body).value);
        return respond({ result: "OK" });
      }
    }
    if (address.startsWith("https://statsapi.mlb.com/api/v1/schedule?")) {
      const date = new URL(address).searchParams.get("date");
      mlbDates.push(date);
      if (responses.mlbByDate.has(date)) {
        const response = responses.mlbByDate.get(date);
        if (response instanceof Error) throw response;
        return respond(response);
      }
      return respond(responses.mlb ?? { dates: [] });
    }
    if (address === "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard") {
      return respond(responses.nfl ?? { events: [] });
    }
    throw new Error(`Unexpected network request: ${address}`);
  };
  const context = vm.createContext({
    exports: {}, require: createRequire(sourcePath), fetch, Date: ClockDate,
    Map, Object, Array, Promise, console: {
      log() {},
      error(...args) {
        logs.errors.push(args.join(" "));
        if (!logs.allowErrors) throw new Error(args.join(" "));
      },
    },
    process: { env: { UPSTASH_REDIS_REST_URL: "https://redis.test", UPSTASH_REDIS_REST_TOKEN: "test" } },
  });
  vm.runInContext(instrumented, context, { filename: sourcePath });
  const api = context.backendUnderTest;
  return {
    api, redis, responses, failures, writes, operations, mlbDates, logs,
    setTime(iso) { clock.now = Date.parse(iso); },
    // Invoke the registered results handlers without opening a real network listener.
    results(route) {
      const layer = api.app._router.stack.find(item => item.route?.path === route);
      assert.ok(layer, `${route} route must exist`);
      let body;
      layer.route.stack[0].handle({}, { json(value) { body = value; } });
      return JSON.parse(JSON.stringify(body));
    },
    async nflRecords() {
      const layer = api.app._router.stack.find(item => item.route?.path === "/nfl-records");
      assert.ok(layer, "NFL record summary route must exist");
      let body;
      let status = 200;
      const res = {
        status(code) { status = code; return this; },
        json(value) { body = value; },
      };
      await layer.route.stack[0].handle({}, res);
      assert.equal(status, 200, JSON.stringify(body));
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
  await h.api.loadFromRedis();
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
  await first.api.loadFromRedis();
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
  await h.api.loadFromRedis();
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
  await h.api.loadFromRedis();
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

test("valid existing MLB season loads without changing its Redis value", async () => {
  const stored = JSON.stringify({ wins: 106, losses: 66, pushes: 0 });
  const h = harness("2026-09-25T12:00:00Z", new Map([["season", stored]]));
  await h.api.loadFromRedis();
  assert.deepEqual(
    [h.api.stats().seasonWins, h.api.stats().seasonLosses, h.api.stats().seasonPushes],
    [106, 66, 0],
  );
  assert.equal(h.results("/results").season.total, 172);
  assert.equal(h.redis.get("season"), stored);
  assert.deepEqual(h.writes, []);
});

test("legacy wrapped MLB season loads exact counters without a write, then saves normalized", async () => {
  const stored = JSON.stringify({ value: JSON.stringify({ wins: 106, losses: 66, pushes: 0 }) });
  const h = harness("2026-09-25T12:00:00Z", new Map([["season", stored]]));
  await h.api.loadFromRedis();
  assert.deepEqual(
    [h.api.stats().seasonWins, h.api.stats().seasonLosses, h.api.stats().seasonPushes],
    [106, 66, 0],
  );
  assert.equal(h.redis.get("season"), stored);
  assert.deepEqual(h.writes, []);
  await h.api.saveToRedis("MLB");
  assert.deepEqual(JSON.parse(h.redis.get("season")), { wins: 106, losses: 66, pushes: 0 });
  assert.deepEqual(h.operations, ["MSET"]);
});

test("malformed legacy wrappers cannot initialize or overwrite the MLB season", async () => {
  const invalid = [
    { value: "not JSON" },
    { value: "null" },
    { value: JSON.stringify({ wins: "106", losses: 66 }) },
    { value: JSON.stringify({ wins: -1, losses: 66 }) },
    { value: JSON.stringify([106, 66, 0]) },
    { value: JSON.stringify({ wins: 106, losses: 66 }), extra: true },
  ];
  for (const record of invalid) {
    const stored = JSON.stringify(record);
    const h = harness("2026-09-25T12:00:00Z", new Map([["season", stored]]));
    await assert.rejects(h.api.loadFromRedis(), /Redis season record is invalid/);
    await assert.rejects(h.api.saveToRedis("MLB"), /Cannot save MLB season/);
    assert.equal(h.redis.get("season"), stored);
    assert.deepEqual(h.writes, []);
  }
});

test("a genuinely absent season initializes at zero, never at the old fallback", async () => {
  const h = harness("2026-09-25T12:00:00Z");
  await h.api.loadFromRedis();
  assert.deepEqual(
    [h.api.stats().seasonWins, h.api.stats().seasonLosses, h.api.stats().seasonPushes],
    [0, 0, 0],
  );
  assert.equal(h.redis.has("season"), false);
  await h.api.saveToRedis("MLB");
  assert.deepEqual(JSON.parse(h.redis.get("season")), { wins: 0, losses: 0, pushes: 0 });
});

test("a Redis season read failure cannot fall back or overwrite the stored season", async () => {
  const stored = JSON.stringify({ wins: 106, losses: 66, pushes: 0 });
  const h = harness("2026-09-25T12:00:00Z", new Map([["season", stored]]));
  h.failures.get.set("season", { body: { error: "unavailable" } });
  await assert.rejects(h.api.loadFromRedis(), /Redis GET season failed: HTTP 503/);
  assert.deepEqual([h.api.stats().seasonWins, h.api.stats().seasonLosses], [0, 0]);
  await assert.rejects(h.api.saveToRedis("MLB"), /Cannot save MLB season before a successful Redis load/);
  assert.equal(h.redis.get("season"), stored);
  assert.deepEqual(h.writes, []);
  await h.api.saveToRedis("NFL");
  assert.equal(h.redis.get("season"), stored);
  assert.equal(h.writes.includes("season"), false);
});

test("a malformed stored season fails closed instead of being reset", async () => {
  const stored = JSON.stringify({ wins: "bad", losses: 66 });
  const h = harness("2026-09-25T12:00:00Z", new Map([["season", stored]]));
  await assert.rejects(h.api.loadFromRedis(), /Redis season record is invalid/);
  await assert.rejects(h.api.saveToRedis("MLB"), /Cannot save MLB season/);
  assert.equal(h.redis.get("season"), stored);
});

test("a stored null season is not mistaken for a never-created key", async () => {
  const h = harness("2026-09-25T12:00:00Z", new Map([["season", "null"]]));
  await assert.rejects(h.api.loadFromRedis(), /Redis GET season contains a stored null value/);
  await assert.rejects(h.api.saveToRedis("MLB"), /Cannot save MLB season/);
  assert.equal(h.redis.get("season"), "null");
});

test("failed Redis writes reject rather than reporting success", async () => {
  const stored = JSON.stringify({ wins: 106, losses: 66, pushes: 0 });
  const h = harness("2026-09-25T12:00:00Z", new Map([["season", stored]]));
  await h.api.loadFromRedis();
  h.failures.mset = { body: { error: "unavailable" } };
  await assert.rejects(h.api.saveToRedis("MLB"), /Redis MLB MSET failed: HTTP 503/);
  assert.equal(h.redis.get("season"), stored);
  h.failures.mset = { ok: true, body: { error: "rejected" } };
  await assert.rejects(h.api.saveToRedis("MLB"), /Redis MLB MSET returned an invalid response/);
  assert.equal(h.redis.get("season"), stored);
  h.failures.mset = null;
  h.failures.set.set("nfl_season", { body: { error: "unavailable" } });
  await assert.rejects(h.api.saveToRedis("NFL"), /Redis SET nfl_season failed: HTTP 503/);
});

test("MLB settlement increments the existing season and persists it once", async () => {
  const start = "2026-09-23T18:00:00Z";
  const h = harness("2026-09-23T17:00:00Z", new Map([
    ["season", JSON.stringify({ wins: 106, losses: 66, pushes: 0 })],
  ]));
  await h.api.loadFromRedis();
  h.api.upsertPregameDraft(h.api.mlb(), draft("existing-season", start, { predictedPlay: "OVER", total: 7.5 }));
  h.setTime(start);
  await h.api.lockDuePredictions();
  h.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  h.setTime("2026-09-24T12:00:00Z");
  await h.api.settlePredictions();
  await h.api.settlePredictions();
  assert.deepEqual(JSON.parse(h.redis.get("season")), { wins: 107, losses: 66, pushes: 0 });
  assert.equal(redisRecord(h.redis, "predictions", "existing-season").settled, true);
  assert.ok(h.operations.every(operation => operation === "MSET"));
  assert.deepEqual([h.api.stats().seasonWins, h.api.stats().seasonLosses], [107, 66]);
});

test("failed MLB settlement save leaves both stored keys unchanged, then retries without double-counting", async () => {
  const start = "2026-09-23T18:00:00Z";
  const h = harness("2026-09-23T17:00:00Z", new Map([
    ["season", JSON.stringify({ wins: 106, losses: 66, pushes: 0 })],
  ]));
  await h.api.loadFromRedis();
  h.api.upsertPregameDraft(h.api.mlb(), draft("retry-mlb", start, { predictedPlay: "OVER", total: 7.5 }));
  h.setTime(start);
  await h.api.lockDuePredictions();
  const beforePrediction = JSON.stringify(redisRecord(h.redis, "predictions", "retry-mlb"));
  h.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  h.setTime("2026-09-24T12:00:00Z");
  h.failures.mset = { body: { error: "unavailable" } };
  h.logs.allowErrors = true;
  await h.api.settlePredictions();
  assert.match(h.logs.errors.at(-1), /Redis MLB MSET failed: HTTP 503/);
  assert.equal(h.api.mlb().get("retry-mlb").settled, true);
  assert.equal(h.api.stats().seasonWins, 107);
  assert.equal(JSON.stringify(redisRecord(h.redis, "predictions", "retry-mlb")), beforePrediction);
  assert.deepEqual(JSON.parse(h.redis.get("season")), { wins: 106, losses: 66, pushes: 0 });

  h.failures.mset = null;
  h.setTime("2026-09-25T12:00:00Z");
  await h.api.settlePredictions();
  await h.api.settlePredictions();
  assert.equal(redisRecord(h.redis, "predictions", "retry-mlb").settled, true);
  assert.deepEqual(JSON.parse(h.redis.get("season")), { wins: 107, losses: 66, pushes: 0 });
  assert.equal(h.api.stats().seasonWins, 107);
});

test("restart after a failed settlement recovers the unresolved locked pick on a later day", async () => {
  const start = "2026-09-23T18:00:00Z";
  const first = harness("2026-09-23T17:00:00Z", new Map([
    ["season", JSON.stringify({ wins: 106, losses: 66, pushes: 0 })],
  ]));
  await first.api.loadFromRedis();
  first.api.upsertPregameDraft(first.api.mlb(), draft("restart-mlb", start, { predictedPlay: "OVER", total: 7.5 }));
  first.setTime(start);
  await first.api.lockDuePredictions();
  first.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  first.setTime("2026-09-24T12:00:00Z");
  first.failures.mset = { body: { error: "unavailable" } };
  first.logs.allowErrors = true;
  await first.api.settlePredictions();

  const restarted = harness("2026-09-27T12:00:00Z", first.redis);
  await restarted.api.loadFromRedis();
  assert.equal(restarted.api.mlb().get("restart-mlb").settled, false);
  assert.deepEqual([restarted.api.stats().seasonWins, restarted.api.stats().seasonLosses], [106, 66]);
  restarted.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  await restarted.api.settlePredictions();
  assert.ok(restarted.mlbDates.includes("2026-09-23"));
  assert.equal(redisRecord(first.redis, "predictions", "restart-mlb").settled, true);
  assert.deepEqual(JSON.parse(first.redis.get("season")), { wins: 107, losses: 66, pushes: 0 });
  await restarted.api.settlePredictions();
  assert.equal(restarted.api.stats().seasonWins, 107);
});

test("failure fetching an old unfinished date does not block newer MLB settlement", async () => {
  const oldStart = "2026-09-21T18:00:00Z";
  const recentStart = "2026-09-23T18:00:00Z";
  const h = harness("2026-09-24T12:00:00Z", new Map([
    ["season", JSON.stringify({ wins: 106, losses: 66, pushes: 0 })],
    ["predictions", JSON.stringify({
      old: draft("old", oldStart, { isLocked: true, lockedAt: oldStart }),
      recent: draft("recent", recentStart, { isLocked: true, lockedAt: recentStart, predictedPlay: "OVER", total: 7.5 }),
    })],
  ]));
  await h.api.loadFromRedis();
  h.responses.mlbByDate.set("2026-09-21", new Error("schedule unavailable"));
  h.responses.mlbByDate.set("2026-09-23", { dates: [{ games: [mlbFinal(recentStart, 4, 4)] }] });
  h.logs.allowErrors = true;
  await h.api.settlePredictions();
  assert.deepEqual(h.mlbDates, ["2026-09-21", "2026-09-23"]);
  assert.equal(redisRecord(h.redis, "predictions", "old").settled, false);
  assert.equal(redisRecord(h.redis, "predictions", "recent").settled, true);
  assert.deepEqual(JSON.parse(h.redis.get("season")), { wins: 107, losses: 66, pushes: 0 });
});

test("a lost response after an atomic MLB commit cannot duplicate the result after restart", async () => {
  const start = "2026-09-23T18:00:00Z";
  const h = harness("2026-09-23T17:00:00Z", new Map([
    ["season", JSON.stringify({ wins: 106, losses: 66, pushes: 0 })],
  ]));
  await h.api.loadFromRedis();
  h.api.upsertPregameDraft(h.api.mlb(), draft("ambiguous-mlb", start, { predictedPlay: "OVER", total: 7.5 }));
  h.setTime(start);
  await h.api.lockDuePredictions();
  h.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  h.setTime("2026-09-24T12:00:00Z");
  h.failures.mset = { afterCommit: true, body: { error: "response lost" } };
  h.logs.allowErrors = true;
  await h.api.settlePredictions();
  const restarted = harness("2026-09-27T12:00:00Z", h.redis);
  await restarted.api.loadFromRedis();
  restarted.responses.mlb = h.responses.mlb;
  await restarted.api.settlePredictions();
  assert.equal(restarted.api.stats().seasonWins, 107);
  assert.equal(redisRecord(h.redis, "predictions", "ambiguous-mlb").settled, true);
});

test("NFL locking and settlement never write the MLB season key", async () => {
  const start = "2026-09-23T20:00:00Z";
  const stored = JSON.stringify({ wins: 106, losses: 66, pushes: 0 });
  const h = harness("2026-09-23T19:00:00Z", new Map([["season", stored]]));
  await h.api.loadFromRedis();
  h.api.upsertPregameDraft(h.api.nfl(), nflDraft("only-nfl", start, { predictedPlay: "UNDER", total: 45.5 }));
  h.setTime(start);
  await h.api.lockDuePredictions();
  h.responses.nfl = { events: [nflFinal(start, 21, 21)] };
  h.setTime("2026-09-24T12:00:00Z");
  await h.api.settleNFLPredictions();
  assert.equal(h.redis.get("season"), stored);
  assert.equal(h.writes.includes("season"), false);
  assert.equal(h.api.stats().nflSeasonWins, 1);
});

test("official NFL calendar groups Thursday, Sunday and Monday games and resets at the next week", async () => {
  const h = harness("2026-09-29T12:00:00Z");
  h.responses.nfl = {
    season: { year: 2026 },
    leagues: [{ calendar: [
      {
        value: "2", startDate: "2026-09-06T07:00Z", endDate: "2027-01-13T07:59Z",
        entries: [
          { label: "Week 2", value: "2", startDate: "2026-09-16T07:00Z", endDate: "2026-09-23T06:59Z" },
          { label: "Week 3", value: "3", startDate: "2026-09-23T07:00Z", endDate: "2026-09-30T06:59Z" },
          { label: "Week 4", value: "4", startDate: "2026-09-30T07:00Z", endDate: "2026-10-07T06:59Z" },
        ],
      },
    ] }],
  };
  const put = (id, time, confidence, result, overrides = {}) => {
    const record = nflDraft(id, time, {
      confidence, result, settled: true, isLocked: true, lockedAt: time, ...overrides,
    });
    h.api.nfl().set(id, record);
  };
  put("week-2", "2026-09-22T00:15:00Z", "HIGH", "LOSS");
  put("thursday", "2026-09-24T00:15:00Z", "HIGH", "WIN");
  put("sunday", "2026-09-27T17:00:00Z", "MEDIUM", "LOSS");
  put("monday-after-midnight", "2026-09-29T00:15:00Z", "LOW", "WIN");
  put("push", "2026-09-28T20:00:00Z", "MEDIUM", "PUSH");
  put("unlocked", "2026-09-27T17:00:00Z", "HIGH", "WIN", { isLocked: false });
  put("unsettled", "2026-09-27T17:00:00Z", "HIGH", "WIN", { settled: false });
  put("no-edge", "2026-09-27T17:00:00Z", "HIGH", "WIN", { predictedPlay: "NO EDGE" });
  put("prior-season", "2025-09-27T17:00:00Z", "HIGH", "WIN");

  const { week, season } = await h.nflRecords();
  assert.equal(week.label, "Week 3");
  assert.equal(week.number, 3);
  assert.deepEqual([week.wins, week.losses, week.pushes, week.pct], [2, 1, 1, 67]);
  assert.deepEqual(week.confidence.HIGH, { wins: 1, losses: 0, pushes: 0 });
  assert.deepEqual(week.confidence.MEDIUM, { wins: 0, losses: 1, pushes: 1 });
  assert.deepEqual(week.confidence.LOW, { wins: 1, losses: 0, pushes: 0 });
  assert.deepEqual([season.wins, season.losses, season.pushes, season.pct], [2, 2, 1, 50]);
  assert.deepEqual(season.confidence.HIGH, { wins: 1, losses: 1, pushes: 0 });

  h.setTime("2026-09-30T07:00:00Z");
  const next = await h.nflRecords();
  assert.equal(next.week.label, "Week 4");
  assert.deepEqual([next.week.wins, next.week.losses, next.week.pct], [0, 0, 0]);
  assert.deepEqual([next.season.wins, next.season.losses], [2, 2]);
});