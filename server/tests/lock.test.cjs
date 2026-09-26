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
  bindOddsToMlbGames, officialForOddsGame, verifiedGamePkForDraft,
  settlePredictions, settleNFLPredictions,
  mlb: () => predictionStore, nfl: () => nflPredictionStore,
  cached: () => cachedGames,
  setCached: (games) => { cachedGames = games; lastCacheTime = Date.now(); },
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
  const failures = { get: new Map(), set: new Map(), draft: null, official: null, grade: null };
  const writes = [];
  const operations = [];
  const mlbDates = [];
  const logs = { allowErrors: false, errors: [] };
  const fetch = async (url, options = {}) => {
    const address = String(url);
    if (address === "https://redis.test") {
      const [command, ...args] = JSON.parse(options.body);
      if (command === "HSCAN") {
        const entries = [...(redis.get(args[0]) ?? new Map()).entries()].flat();
        return respond({ result: ["0", entries] });
      }
      if (command === "HGET") return respond({ result: (redis.get(args[0]) ?? new Map()).get(args[1]) ?? null });
      if (command === "HSETNX") {
        const [key, field, value] = args;
        const failure = failures.official;
        if (failure && !failure.afterCommit) return respond(failure.body ?? { error: "unavailable" }, false);
        const hash = redis.get(key) ?? new Map();
        const created = hash.has(field) ? 0 : 1;
        if (created) hash.set(field, value);
        redis.set(key, hash);
        if (created) writes.push(key);
        operations.push("HSETNX");
        if (failure) return respond(failure.body ?? { error: "response lost" }, false);
        return respond({ result: created });
      }
      if (command === "EVAL") {
        if (args[1] === "1") {
          const [, , key, field, value, updatedAt] = args;
          const failure = failures.draft;
          if (failure instanceof Error) throw failure;
          if (failure && !failure.afterCommit) return respond(failure.body ?? { error: "unavailable" }, failure.ok ?? false);
          const hash = redis.get(key) ?? new Map();
          const existing = hash.get(field);
          const accepted = !existing || (JSON.parse(existing).draftUpdatedAt ?? 0) <= Number(updatedAt);
          if (accepted) {
            hash.set(field, value);
            redis.set(key, hash);
            writes.push(key);
          }
          operations.push("EVAL_DRAFT");
          if (failure) return respond(failure.body ?? { error: "response lost" }, failure.ok ?? false);
          return respond({ result: accepted ? 1 : 0 });
        }
        const [, , key, seasonKey, field, result, runs, settledAt] = args;
        const failure = failures.grade;
        if (failure && !failure.afterCommit) return respond(failure.body ?? { error: "unavailable" }, false);
        const hash = redis.get(key) ?? new Map();
        const raw = hash.get(field);
        if (!raw) return respond({ error: "official missing" }, false);
        const record = JSON.parse(raw);
        if (!record.settled) {
          record.settled = true; record.result = result;
          record.actualRuns = Number(runs); record.settledAt = settledAt;
          const season = redis.has(seasonKey) ? JSON.parse(redis.get(seasonKey)) : { wins: 0, losses: 0, pushes: 0 };
          if (result === "WIN") season.wins++;
          else if (result === "LOSS") season.losses++;
          else season.pushes++;
          hash.set(field, JSON.stringify(record));
          redis.set(seasonKey, JSON.stringify(season));
          writes.push(key, seasonKey);
        }
        operations.push("EVAL");
        if (failure) return respond(failure.body ?? { error: "response lost" }, false);
        return respond({ result: [record.settled ? 1 : 0, JSON.stringify(record), redis.get(seasonKey)] });
      }
      throw new Error(`Unexpected Redis command: ${command}`);
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
      const params = new URL(address).searchParams;
      const date = params.get("date");
      const gamePk = params.get("gamePks");
      mlbDates.push(date);
      if (gamePk) {
        const source = responses.mlbByDate.get(date) ?? responses.mlb ?? { dates: [] };
        return respond({
          dates: (source.dates ?? []).map(day => ({
            ...day, games: (day.games ?? []).filter(game => String(game.gamePk) === gamePk),
          })),
        });
      }
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
    async results(route) {
      const layer = api.app._router.stack.find(item => item.route?.path === route);
      assert.ok(layer, `${route} route must exist`);
      let body;
      let status = 200;
      await layer.route.stack[0].handle({}, {
        status(code) { status = code; return this; },
        json(value) { body = value; },
      });
      assert.equal(status, 200, JSON.stringify(body));
      return JSON.parse(JSON.stringify(body));
    },
    async games() {
      const layer = api.app._router.stack.find(item => item.route?.path === "/games");
      assert.ok(layer);
      let body;
      let status = 200;
      await layer.route.stack[0].handle({}, {
        setHeader() {},
        status(code) { status = code; return this; },
        json(value) { body = value; },
      });
      assert.equal(status, 200, JSON.stringify(body));
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
    gameId, mlbGamePk: 1, commenceTime, date: commenceTime.slice(0, 10),
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

function mlbFinal(gameDate, homeScore, awayScore, gamePk = 1) {
  return {
    gamePk, gameDate, status: { abstractGameState: "Final", detailedState: "Final" },
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
  assert.deepEqual(officialRecord(h.redis, 1), locked);
});

function redisRecord(redis, collection, gameId) {
  return JSON.parse(redis.get(collection))[gameId];
}
function officialRecord(redis, gamePk = 1) {
  return JSON.parse(redis.get("mlb_official_v1").get(String(gamePk)));
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
  assert.deepEqual(officialRecord(first.redis), locked);
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
  h.api.upsertPregameDraft(store, draft("game-2", secondStart, { mlbGamePk: 2, predictedPlay: "UNDER", confidence: "HIGH", total: 9.5 }));
  h.setTime(firstStart);
  await h.api.lockDuePredictions();
  assert.equal(store.get("game-1").lockedAt, "2026-09-23T17:00:00.000Z");
  assert.equal(store.get("game-2").isLocked, false);
  h.setTime("2026-09-23T22:00:00Z");
  assert.equal(h.api.upsertPregameDraft(store, draft("game-2", secondStart, { mlbGamePk: 2, predictedPlay: "UNDER", total: 8.5 })), true);
  h.setTime(secondStart);
  await h.api.lockDuePredictions();
  assert.equal(store.get("game-2").lockedAt, "2026-09-23T23:00:00.000Z");
  assert.equal(store.get("game-2").total, 8.5);
  h.responses.mlb = { dates: [{ games: [mlbFinal(secondStart, 4, 4, 2), mlbFinal(firstStart, 4, 4, 1)] }] };
  h.setTime("2026-09-24T12:00:00Z");
  await h.api.settlePredictions();
  assert.equal(store.get("game-1").result, "WIN");
  assert.equal(store.get("game-2").result, "WIN");
  assert.equal(store.get("game-1").actualRuns, 8);
  assert.equal(store.get("game-2").actualRuns, 8);
});

test("a failed individual MLB lock never publishes an official pick and can retry", async () => {
  const start = "2026-09-23T18:00:00Z";
  const h = harness("2026-09-23T17:00:00Z");
  await h.api.loadFromRedis();
  h.api.upsertPregameDraft(h.api.mlb(), draft("failed-lock", start));
  h.setTime(start);
  h.failures.official = { body: { error: "too large" } };
  h.logs.allowErrors = true;
  await h.api.lockDuePredictions();
  assert.equal(h.api.mlb().get("failed-lock").isLocked, false);
  assert.equal(h.redis.has("mlb_official_v1"), false);
  assert.match(h.logs.errors.at(-1), /MLB lock persistence failed/);
  h.failures.official = null;
  await h.api.lockDuePredictions();
  assert.equal(officialRecord(h.redis).isLocked, true);
  assert.equal(h.api.mlb().get("failed-lock").isLocked, true);
});

test("a confirmed lock invalidates a pregame /games cache immediately", async () => {
  const start = "2026-09-23T18:00:00Z";
  const h = harness("2026-09-23T17:00:00Z");
  await h.api.loadFromRedis();
  h.api.upsertPregameDraft(h.api.mlb(), draft("cached-game", start));
  h.api.setCached([{ id: "cached-game", is_locked: false, official_pick: null }]);
  h.setTime(start);
  await h.api.lockDuePredictions();
  assert.equal(h.api.cached(), null, "the old unlocked response cannot be served after a confirmed lock");
});

test("a schedule outage keeps a prior verified binding but ambiguity never reuses it", () => {
  const h = harness("2026-09-23T17:00:00Z");
  const previous = draft("odds-id", "2026-09-23T18:00:00Z", { mlbGamePk: 124 });
  const args = [undefined, previous, true, previous.homeTeam, previous.awayTeam, previous.commenceTime];
  assert.equal(h.api.verifiedGamePkForDraft(...args), 124);
  assert.equal(h.api.verifiedGamePkForDraft(undefined, previous, false, previous.homeTeam, previous.awayTeam, previous.commenceTime), undefined);
  assert.equal(h.api.verifiedGamePkForDraft(undefined, previous, true, previous.homeTeam, previous.awayTeam, "2026-09-23T19:00:00Z"), undefined);
});

test("lost lock response is reconciled; failed draft writes cannot erase an official lock", async () => {
  const start = "2026-09-23T18:00:00Z";
  const old = JSON.stringify({ untouched: draft("untouched", "2026-09-22T18:00:00Z", {
    mlbGamePk: undefined, isLocked: true, lockedAt: "2026-09-22T18:00:00Z",
  }) });
  const season = JSON.stringify({ wins: 106, losses: 66, pushes: 0 });
  const h = harness("2026-09-23T17:00:00Z", new Map([["predictions", old], ["season", season]]));
  await h.api.loadFromRedis();
  h.api.upsertPregameDraft(h.api.mlb(), draft("lost-lock-response", start, { confidence: "HIGH" }));
  h.setTime(start);
  h.failures.official = { afterCommit: true, body: { error: "response lost" } };
  await h.api.lockDuePredictions();
  assert.equal(h.api.mlb().get("lost-lock-response").isLocked, true);
  assert.equal(officialRecord(h.redis).confidence, "HIGH");
  h.api.upsertPregameDraft(h.api.mlb(), draft("next-game", "2026-09-24T18:00:00Z", { mlbGamePk: 2 }));
  h.failures.draft = { body: { error: "request too large" } };
  await assert.rejects(h.api.saveToRedis("MLB"), /Redis MLB draft EVAL failed/);
  assert.equal(h.redis.get("predictions"), old);
  assert.equal(h.redis.get("season"), season);
  const restarted = harness("2026-09-23T19:00:00Z", h.redis);
  await restarted.api.loadFromRedis();
  assert.equal(restarted.api.mlb().get("lost-lock-response").confidence, "HIGH");
  assert.equal(restarted.api.mlb().get("lost-lock-response").isLocked, true);
});

test("immutable gamePk lock rejects a different odds event and keeps the first snapshot", async () => {
  const start = "2026-09-23T18:00:00Z";
  const h = harness("2026-09-23T17:00:00Z");
  await h.api.loadFromRedis();
  h.api.upsertPregameDraft(h.api.mlb(), draft("first-event", start, { total: 7.5 }));
  h.setTime(start);
  await h.api.lockDuePredictions();
  const original = officialRecord(h.redis);
  h.api.mlb().set("second-event", draft("second-event", start, { total: 9.5 }));
  h.logs.allowErrors = true;
  await h.api.lockDuePredictions();
  assert.equal(h.api.mlb().get("second-event").isLocked, undefined);
  assert.deepEqual(officialRecord(h.redis), original);
  assert.match(h.logs.errors.at(-1), /MLB lock persistence failed/);
});

test("odds-to-MLB binding refuses ambiguous doubleheaders and duplicate odds events", () => {
  const h = harness("2026-09-23T12:00:00Z");
  const schedule = [
    { gamePk: 1, gameDate: "2026-09-23T18:00:00Z", homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals" },
    { gamePk: 2, gameDate: "2026-09-23T18:20:00Z", homeTeam: "Chicago Cubs", awayTeam: "St. Louis Cardinals" },
  ];
  const odds = time => ({ id: time, home_team: "Chicago Cubs", away_team: "St. Louis Cardinals", commence_time: time });
  const bound = h.api.bindOddsToMlbGames(
    [odds("2026-09-23T18:00:00Z"), odds("2026-09-23T18:20:00Z")], schedule);
  assert.equal(bound.get("2026-09-23T18:00:00Z").gamePk, 1);
  assert.equal(bound.get("2026-09-23T18:20:00Z").gamePk, 2);
  assert.equal(h.api.bindOddsToMlbGames([odds("2026-09-23T18:10:00Z")], schedule).size, 0);
  const shifted = h.api.bindOddsToMlbGames([
    odds("2026-09-23T18:25:00Z"), odds("2026-09-23T18:20:00Z"),
  ], schedule);
  assert.equal(shifted.has("2026-09-23T18:25:00Z"), false, "a shifted start must not silently attach to the other game");
  const duplicates = [odds("2026-09-23T18:00:00Z"), { ...odds("2026-09-23T18:00:30Z"), id: "duplicate" }];
  assert.equal(h.api.bindOddsToMlbGames(duplicates, schedule).size, 0);
});

test("a changed odds ID still publishes the immutable pick by verified MLB gamePk", async () => {
  const start = "2026-09-23T18:00:00Z";
  const first = harness("2026-09-23T17:00:00Z");
  await first.api.loadFromRedis();
  first.api.upsertPregameDraft(first.api.mlb(), draft("old-odds-id", start, { confidence: "HIGH" }));
  first.setTime(start);
  await first.api.lockDuePredictions();
  const restarted = harness("2026-09-23T18:15:00Z", first.redis);
  await restarted.api.loadFromRedis();
  assert.equal(restarted.api.officialForOddsGame("new-odds-id", 1).gameId, "old-odds-id");
  assert.equal(restarted.api.officialForOddsGame("new-odds-id", 1).confidence, "HIGH");
  assert.equal(restarted.api.officialForOddsGame("old-odds-id", 2), undefined, "an old odds ID cannot override a changed gamePk");
  assert.equal(restarted.api.officialForOddsGame("old-odds-id"), undefined, "an unverified event cannot publish a lock");
});

test("a stale second process saving drafts cannot roll back the settled season", async () => {
  const start = "2026-09-23T18:00:00Z";
  const redis = new Map([["season", JSON.stringify({ wins: 106, losses: 66, pushes: 0 })]]);
  const grader = harness("2026-09-23T17:00:00Z", redis);
  const stale = harness("2026-09-23T17:00:00Z", redis);
  await grader.api.loadFromRedis();
  await stale.api.loadFromRedis();
  grader.api.upsertPregameDraft(grader.api.mlb(), draft("two-processes", start, { predictedPlay: "OVER", total: 7.5 }));
  grader.setTime(start);
  await grader.api.lockDuePredictions();
  grader.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  grader.setTime("2026-09-24T12:00:00Z");
  await grader.api.settlePredictions();
  await stale.api.saveToRedis("MLB");
  assert.deepEqual(JSON.parse(redis.get("season")), { wins: 107, losses: 66, pushes: 0 });
  assert.equal(officialRecord(redis).settled, true);
});

test("a second instance reports the atomic season and result without restarting", async () => {
  const start = "2026-09-23T18:00:00Z";
  const redis = new Map([["season", JSON.stringify({ wins: 106, losses: 66, pushes: 0 })]]);
  const grader = harness("2026-09-23T17:00:00Z", redis);
  const viewer = harness("2026-09-23T17:00:00Z", redis);
  await grader.api.loadFromRedis();
  await viewer.api.loadFromRedis();
  grader.api.upsertPregameDraft(grader.api.mlb(), draft("shared-result", start, {
    predictedPlay: "OVER", total: 7.5,
  }));
  grader.setTime(start);
  await grader.api.lockDuePredictions();
  grader.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  grader.setTime("2026-09-24T12:00:00Z");
  await grader.api.settlePredictions();
  viewer.setTime("2026-09-24T12:00:00Z");
  const results = await viewer.results("/results");
  assert.equal(results.season.wins, 107);
  assert.equal(results.yesterday.games[0].gameId, "shared-result");
  assert.equal(results.yesterday.games[0].result, "WIN");
});

test("two instances cannot erase each other's verified drafts before kickoff", async () => {
  const start = "2026-09-23T18:00:00Z";
  const redis = new Map([["season", JSON.stringify({ wins: 106, losses: 66, pushes: 0 })]]);
  const a = harness("2026-09-23T17:00:00Z", redis);
  const b = harness("2026-09-23T17:00:00Z", redis);
  await a.api.loadFromRedis();
  await b.api.loadFromRedis();
  a.api.upsertPregameDraft(a.api.mlb(), draft("game-a", start, { mlbGamePk: 11 }));
  await a.api.saveToRedis("MLB");
  b.api.upsertPregameDraft(b.api.mlb(), draft("game-b", start, { mlbGamePk: 22 }));
  await b.api.saveToRedis("MLB");
  assert.equal(redis.has("predictions"), false, "old bulk collection must not be rewritten");
  const restarted = harness(start, redis);
  await restarted.api.loadFromRedis();
  assert.equal(restarted.api.mlb().size, 2);
  await restarted.api.lockDuePredictions();
  assert.equal(officialRecord(redis, 11).gameId, "game-a");
  assert.equal(officialRecord(redis, 22).gameId, "game-b");
});

test("a surviving instance locks another instance's draft after its writer exits", async () => {
  const start = "2026-09-23T18:00:00Z";
  const redis = new Map();
  const writer = harness("2026-09-23T17:00:00Z", redis);
  const survivor = harness("2026-09-23T17:00:00Z", redis);
  await writer.api.loadFromRedis();
  await survivor.api.loadFromRedis();
  writer.api.upsertPregameDraft(writer.api.mlb(), draft("from-writer", start, { confidence: "HIGH" }));
  await writer.api.saveToRedis("MLB");
  // Writer is no longer used. Survivor was running before the draft existed.
  survivor.setTime(start);
  await survivor.api.lockDuePredictions();
  assert.equal(officialRecord(redis).confidence, "HIGH");
  assert.equal(survivor.api.mlb().get("from-writer").isLocked, true);
});

test("a surviving instance honors an earlier persisted start instead of its stale local start", async () => {
  const redis = new Map();
  const writer = harness("2026-09-23T17:00:00Z", redis);
  const survivor = harness("2026-09-23T17:00:00Z", redis);
  await writer.api.loadFromRedis();
  await survivor.api.loadFromRedis();
  survivor.api.upsertPregameDraft(survivor.api.mlb(), draft("moved-start", "2026-09-23T20:00:00Z"));
  writer.api.upsertPregameDraft(writer.api.mlb(), draft("moved-start", "2026-09-23T18:00:00Z"));
  await writer.api.saveToRedis("MLB");
  survivor.setTime("2026-09-23T18:00:00Z");
  await survivor.api.lockDuePredictions();
  assert.equal(officialRecord(redis).lockedAt, "2026-09-23T18:00:00.000Z");
});

test("a stale instance cannot overwrite a newer pregame snapshot for the same gamePk", async () => {
  const start = "2026-09-23T18:00:00Z";
  const redis = new Map();
  const newer = harness("2026-09-23T17:30:00Z", redis);
  const stale = harness("2026-09-23T17:00:00Z", redis);
  await newer.api.loadFromRedis();
  await stale.api.loadFromRedis();
  stale.api.upsertPregameDraft(stale.api.mlb(), draft("same-game", start, { confidence: "LOW" }));
  newer.api.upsertPregameDraft(newer.api.mlb(), draft("same-game", start, { confidence: "HIGH" }));
  await newer.api.saveToRedis("MLB");
  await stale.api.saveToRedis("MLB");
  const restarted = harness(start, redis);
  await restarted.api.loadFromRedis();
  assert.equal(restarted.api.mlb().get("same-game").confidence, "HIGH");
  await restarted.api.lockDuePredictions();
  assert.equal(officialRecord(redis).confidence, "HIGH");
});

test("another instance's cached /games response adopts a newly confirmed lock", async () => {
  const start = "2026-09-23T18:00:00Z";
  const redis = new Map();
  const locking = harness("2026-09-23T17:00:00Z", redis);
  const serving = harness("2026-09-23T17:00:00Z", redis);
  await locking.api.loadFromRedis();
  await serving.api.loadFromRedis();
  serving.api.setCached([{
    id: "cross-instance", mlb_game_pk: 1, is_locked: false, official_pick: null, total: 9.5,
  }]);
  locking.api.upsertPregameDraft(locking.api.mlb(), draft("cross-instance", start, { total: 7.5 }));
  locking.setTime(start);
  await locking.api.lockDuePredictions();
  const [game] = await serving.games();
  assert.equal(game.is_locked, true);
  assert.equal(game.total, 7.5);
  assert.equal(game.official_pick.line, 7.5);
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
  const results = await h.results("/results");
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
  const results = await h.results("/nfl-results");
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
  assert.equal((await h.results("/results")).season.total, 172);
  assert.equal(h.redis.get("season"), stored);
  assert.deepEqual(h.writes, []);
});

test("legacy wrapped MLB season stays unchanged after a draft save", async () => {
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
  assert.equal(h.redis.get("season"), stored);
  assert.deepEqual(h.operations, []);
});

test("legacy wrapped predictions restore every record and save with the unchanged season", async () => {
  const start = "2026-09-25T18:00:00Z";
  const predictions = Object.fromEntries(
    Array.from({ length: 61 }, (_, i) => [`mlb-${i}`, draft(`mlb-${i}`, start, { mlbGamePk: undefined })]),
  );
  const storedPredictions = JSON.stringify({ value: JSON.stringify(predictions) });
  const storedSeason = JSON.stringify({ value: JSON.stringify({ wins: 106, losses: 66, pushes: 0 }) });
  const h = harness("2026-09-25T12:00:00Z", new Map([
    ["predictions", storedPredictions], ["season", storedSeason],
  ]));
  await h.api.loadFromRedis();
  assert.equal(h.api.mlb().size, 61);
  assert.equal(h.api.mlb().has("value"), false);
  assert.deepEqual([h.api.stats().seasonWins, h.api.stats().seasonLosses], [106, 66]);
  assert.equal(h.redis.get("predictions"), storedPredictions);
  assert.deepEqual(h.writes, []);
  await h.api.saveToRedis("MLB");
  assert.equal(h.redis.get("predictions"), storedPredictions);
  assert.equal(h.redis.get("season"), storedSeason);
  assert.deepEqual(h.operations, []);
});

test("malformed legacy predictions cannot be overwritten", async () => {
  for (const value of ["not JSON", "null", JSON.stringify([])]) {
    const stored = JSON.stringify({ value });
    const h = harness("2026-09-25T12:00:00Z", new Map([["predictions", stored]]));
    await assert.rejects(h.api.loadFromRedis(), /Redis predictions record is invalid/);
    await assert.rejects(h.api.saveToRedis("MLB"), /Cannot save MLB season/);
    assert.equal(h.redis.get("predictions"), stored);
    assert.deepEqual(h.writes, []);
  }
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
  assert.equal(h.redis.has("season"), false, "a draft save must not manufacture or overwrite a season");
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
  h.api.upsertPregameDraft(h.api.mlb(), draft("write-failure", "2026-09-25T18:00:00Z"));
  h.failures.draft = { body: { error: "unavailable" } };
  await assert.rejects(h.api.saveToRedis("MLB"), /Redis MLB draft EVAL failed: HTTP 503/);
  assert.equal(h.redis.get("season"), stored);
  h.failures.draft = { ok: true, body: { error: "rejected" } };
  await assert.rejects(h.api.saveToRedis("MLB"), /Redis MLB draft EVAL returned an invalid response/);
  assert.equal(h.redis.get("season"), stored);
  h.failures.draft = null;
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
  assert.equal(officialRecord(h.redis).settled, true);
  assert.deepEqual(h.operations, ["HSETNX", "EVAL"]);
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
  const beforePrediction = JSON.stringify(officialRecord(h.redis));
  h.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  h.setTime("2026-09-24T12:00:00Z");
  h.failures.grade = { body: { error: "unavailable" } };
  h.logs.allowErrors = true;
  await h.api.settlePredictions();
  assert.match(h.logs.errors.at(-1), /Redis MLB grade failed: HTTP 503/);
  assert.equal(h.api.mlb().get("retry-mlb").settled, false);
  assert.equal(h.api.stats().seasonWins, 106);
  assert.equal(JSON.stringify(officialRecord(h.redis)), beforePrediction);
  assert.deepEqual(JSON.parse(h.redis.get("season")), { wins: 106, losses: 66, pushes: 0 });

  h.failures.grade = null;
  h.setTime("2026-09-25T12:00:00Z");
  await h.api.settlePredictions();
  await h.api.settlePredictions();
  assert.equal(officialRecord(h.redis).settled, true);
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
  first.failures.grade = { body: { error: "unavailable" } };
  first.logs.allowErrors = true;
  await first.api.settlePredictions();

  const restarted = harness("2026-09-27T12:00:00Z", first.redis);
  await restarted.api.loadFromRedis();
  assert.equal(restarted.api.mlb().get("restart-mlb").settled, false);
  assert.deepEqual([restarted.api.stats().seasonWins, restarted.api.stats().seasonLosses], [106, 66]);
  restarted.responses.mlb = { dates: [{ games: [mlbFinal(start, 4, 4)] }] };
  await restarted.api.settlePredictions();
  assert.ok(restarted.mlbDates.includes(null), "settlement should query the exact gamePk, not a date/matchup guess");
  assert.equal(officialRecord(first.redis).settled, true);
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
      old: draft("old", oldStart, { mlbGamePk: undefined, isLocked: true, lockedAt: oldStart }),
      recent: draft("recent", recentStart, { mlbGamePk: undefined, isLocked: true, lockedAt: recentStart, predictedPlay: "OVER", total: 7.5 }),
    })],
  ]));
  await h.api.loadFromRedis();
  h.responses.mlbByDate.set("2026-09-21", new Error("schedule unavailable"));
  h.responses.mlbByDate.set("2026-09-23", { dates: [{ games: [mlbFinal(recentStart, 4, 4)] }] });
  h.logs.allowErrors = true;
  await h.api.settlePredictions();
  assert.deepEqual(h.mlbDates, ["2026-09-21", "2026-09-23"]);
  assert.equal(redisRecord(h.redis, "predictions", "old").settled, false);
  assert.equal(redisRecord(h.redis, "predictions", "recent").settled, false, "legacy collection stays intact");
  assert.equal(officialRecord(h.redis).settled, true);
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
  h.failures.grade = { afterCommit: true, body: { error: "response lost" } };
  h.logs.allowErrors = true;
  await h.api.settlePredictions();
  const restarted = harness("2026-09-27T12:00:00Z", h.redis);
  await restarted.api.loadFromRedis();
  restarted.responses.mlb = h.responses.mlb;
  await restarted.api.settlePredictions();
  assert.equal(restarted.api.stats().seasonWins, 107);
  assert.equal(officialRecord(h.redis).settled, true);
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