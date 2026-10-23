// Runs the balance harness and prints its report as Markdown. Not part of the game: a tool for tuning the defaults.
//
//   npm run balance -w sim                              every strategy, seeds 1–5, on the default config
//   npm run balance -w sim -- --seeds 10 --out report.md
//   npm run balance -w sim -- --strategy sensible,no-loan --overrides preset.json
//   npm run balance -w sim -- --difficulty hard
//
// --difficulty plays every game on Easy, Normal (the default) or Hard. --overrides takes a JSON file of config overrides (path → number), as the teacher's config page saves them. --json
// writes every game's result as well, for a closer look.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { applyOverrides, defaultConfig, DIFFICULTY_IDS, isDifficultyId, validateOverrides } from "../src/index.ts";
import { renderReport, runAll, STRATEGIES } from "./harness.ts";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "5" },
    strategy: { type: "string" },
    overrides: { type: "string" },
    out: { type: "string" },
    title: { type: "string" },
    json: { type: "string" },
    difficulty: { type: "string", default: "normal" },
  },
});

let config = defaultConfig;
if (values.overrides) {
  const overrides: unknown = JSON.parse(readFileSync(values.overrides, "utf8"));
  const errors = validateOverrides(overrides);
  if (Object.keys(errors).length) {
    console.error("Overrides rejected:", errors);
    process.exit(1);
  }
  config = applyOverrides(overrides as Record<string, number>);
}

const difficulty = values.difficulty;
if (!isDifficultyId(difficulty)) {
  console.error(`No such difficulty. Pick from: ${DIFFICULTY_IDS.join(", ")}`);
  process.exit(1);
}
// Every game plays on the one difficulty allowed.
config = { ...config, allowedDifficulties: { easy: 0, normal: 0, hard: 0, [difficulty]: 1 } };

const seeds = Array.from({ length: Number(values.seeds) }, (_, i) => i + 1);
const wanted = values.strategy?.split(",");
const strategies = wanted ? STRATEGIES.filter((s) => wanted.includes(s.id)) : STRATEGIES;
if (!strategies.length) {
  console.error(`No such strategy. Pick from: ${STRATEGIES.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

const results = runAll(config, { seeds, strategies });
const report = renderReport(results, { seeds, strategies, title: values.title });
if (values.out) writeFileSync(values.out, `${report}\n`);
if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 2));
console.log(report);
