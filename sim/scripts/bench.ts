// Times the sim on realistic games: the balance harness's sensible bot on every model × product. Not part of the game:
// a tool for checking the sim stays fast as the daily history grows.
//
//   npm run bench -w sim
//   npm run bench -w sim -- --seeds 5 --json bench.json
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { createSim, defaultConfig, MODEL_IDS, PRODUCT_TYPE_IDS, type GameState, type Sim } from "../src/index.ts";
import { playDay, STRATEGIES } from "./harness.ts";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "3" },
    json: { type: "string" },
  },
});
const seeds = Array.from({ length: Number(values.seeds) }, (_, i) => i + 1);
const sensible = STRATEGIES.find((s) => s.id === "sensible")!;

/** Runs fn `times` times and returns the mean milliseconds per call. */
function time(fn: () => unknown, times: number): number {
  const start = performance.now();
  for (let i = 0; i < times; i++) fn();
  return (performance.now() - start) / times;
}

const median = (ns: number[]) => {
  const s = [...ns].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const mean = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);

// Advance time by day bucket: does a day cost more as the history grows?
const BUCKET = 30;
const advanceByBucket = new Map<number, number[]>();
const states: GameState[] = [];
const sim: Sim = createSim(defaultConfig);

function playOne(model: (typeof MODEL_IDS)[number], productType: (typeof PRODUCT_TYPE_IDS)[number], seed: number) {
  const takeLoan = model === "onprem";
  let state = sim.newGame({ companyName: "Bench Ltd", productType, model, seed, takeLoan });
  let lastPlaying = state;
  while (state.status === "playing") {
    state = playDay(sim, state, sensible);
    lastPlaying = state;
    const t0 = performance.now();
    state = sim.advance(state).state;
    const ms = performance.now() - t0;
    const bucket = Math.floor((state.day - 1) / BUCKET);
    advanceByBucket.set(bucket, [...(advanceByBucket.get(bucket) ?? []), ms]);
  }
  states.push(lastPlaying);
  return state;
}

// Warm up the JIT on one game first, so the first bucket isn't all compile time.
playOne("iaas", "social", 99);
advanceByBucket.clear();
states.length = 0;

const gameStart = performance.now();
const finals: GameState[] = [];
for (const model of MODEL_IDS) {
  for (const productType of PRODUCT_TYPE_IDS) {
    for (const seed of seeds) finals.push(playOne(model, productType, seed));
  }
}
const gameMs = (performance.now() - gameStart) / finals.length;

// The views a student's request computes, on the last state still being played (late in the game, the biggest).
const late = states.filter((s) => s.day >= 170);
const per = (fn: (s: GameState) => unknown, times = 20) => mean(late.map((s) => time(() => fn(s), times)));
const summariseMs = per((s) => sim.summarise(s));
const pricePreviewMs = per((s) => sim.pricePreview(s, Math.round(s.price * 1.2 * 100) / 100));
const migrationQuoteMs = per((s) => sim.migrationQuote(s, s.model === "saas" ? "iaas" : "saas"));
const createSimMs = time(() => createSim(defaultConfig), 50);

const sizes = finals.map((s) => JSON.stringify(s).length);
const biggest = finals[sizes.indexOf(Math.max(...sizes))]!;
const text = JSON.stringify(biggest);
const stringifyMs = time(() => JSON.stringify(biggest), 200);
const parseMs = time(() => JSON.parse(text), 200);
const configBytes = JSON.stringify(defaultConfig).length;
const configStringifyMs = time(() => JSON.stringify(defaultConfig), 200);

const buckets = [...advanceByBucket.keys()].sort((a, b) => a - b).map((b) => {
  const ms = advanceByBucket.get(b)!;
  return { days: `${b * BUCKET + 1}–${(b + 1) * BUCKET}`, meanMs: mean(ms), medianMs: median(ms), samples: ms.length };
});

const result = {
  games: finals.length,
  gameMs,
  advance: buckets,
  summariseMs,
  pricePreviewMs,
  migrationQuoteMs,
  createSimMs,
  stateBytes: { median: median(sizes), max: Math.max(...sizes) },
  stateStringifyMs: stringifyMs,
  stateParseMs: parseMs,
  configBytes,
  configStringifyMs,
};

const f = (ms: number) => `${ms < 0.1 ? (ms * 1000).toFixed(1) + " µs" : ms.toFixed(3) + " ms"}`;
console.log(`# Sim benchmark (${finals.length} sensible games, seeds ${seeds.join(", ")})\n`);
console.log(`Whole game, bot included: ${gameMs.toFixed(1)} ms\n`);
console.log("| Days | advance mean | advance median |\n| --- | --- | --- |");
for (const b of buckets) console.log(`| ${b.days} | ${f(b.meanMs)} | ${f(b.medianMs)} |`);
console.log(`\n| Call (late game) | Time |\n| --- | --- |`);
console.log(`| summarise | ${f(summariseMs)} |`);
console.log(`| pricePreview | ${f(pricePreviewMs)} |`);
console.log(`| migrationQuote | ${f(migrationQuoteMs)} |`);
console.log(`| createSim | ${f(createSimMs)} |`);
console.log(`| JSON.stringify state (${(result.stateBytes.max / 1024).toFixed(1)} KB) | ${f(stringifyMs)} |`);
console.log(`| JSON.parse state | ${f(parseMs)} |`);
console.log(`| JSON.stringify config (${(configBytes / 1024).toFixed(1)} KB) | ${f(configStringifyMs)} |`);
console.log(`\nState at the end: median ${(result.stateBytes.median / 1024).toFixed(1)} KB, max ${(result.stateBytes.max / 1024).toFixed(1)} KB`);
if (values.json) writeFileSync(values.json, JSON.stringify(result, null, 2));
