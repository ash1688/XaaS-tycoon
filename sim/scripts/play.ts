// The AI playtest command line: play one game of XaaS Tycoon as text, a few commands at a time. The game is saved to
// a JSON file between calls, and every game writes a playtest log beside it (<game>.log.json) in the classroom
// export's format. See textPlay.ts.
//
//   npm run play -- new <game.json> --product social --model paas [--loan] [--length 1-year] [--shares 10000] [--seed 1] [--player "AI 1"] [--playstyle min-maxer]
//   npm run play -- look <game.json>
//   npm run play -- do <game.json> "hire support 3; price 6; next 7"
//   npm run play -- summary <game.json>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createSim, defaultConfig, GAME_LENGTH_IDS, PRODUCT_TYPE_IDS, SimError, type GameState } from "../src/index.ts";
import {
  logRow,
  renderCommands,
  renderStatus,
  renderSummary,
  runScript,
  type LogRow,
  type Player,
} from "./textPlay.ts";

interface SavedGame extends Player {
  seed: number;
  state: GameState;
}

// The default config, with every game length allowed so a playtester can try any of them.
const sim = createSim({
  ...defaultConfig,
  allowedGameLengths: Object.fromEntries(GAME_LENGTH_IDS.map((l) => [l, 1])) as typeof defaultConfig.allowedGameLengths,
});
const logPath = (file: string) => file.replace(/\.json$/, "") + ".log.json";

function load(file: string): SavedGame {
  if (!existsSync(file)) throw new SimError("no_game", `No game at ${file}. Start one with "new".`);
  const saved = JSON.parse(readFileSync(file, "utf8")) as SavedGame;
  return { ...saved, state: sim.load(saved.state) };
}

function save(file: string, game: SavedGame, rows: LogRow[]) {
  writeFileSync(file, JSON.stringify(game));
  const log: LogRow[] = existsSync(logPath(file)) ? JSON.parse(readFileSync(logPath(file), "utf8")) : [];
  writeFileSync(logPath(file), JSON.stringify([...log, ...rows]));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The products to pick from, for --product: "ecommerce (E-commerce platform: Big seasonal traffic spikes), ...". */
const productList = () =>
  PRODUCT_TYPE_IDS.map((id) => `${id} (${defaultConfig.productTypes[id].name}: ${defaultConfig.productTypes[id].profile})`).join(", ");

function newGame(file: string, args: string[]) {
  const product = flag(args, "product") ?? "";
  if (!(PRODUCT_TYPE_IDS as readonly string[]).includes(product)) {
    throw new SimError("unknown_product_type", `Pick a product with --product: ${productList()}.`);
  }
  const seed = Number(flag(args, "seed") ?? Math.floor(Math.random() * 1_000_000));
  const player = flag(args, "player") ?? "AI playtester";
  const playstyle = flag(args, "playstyle");
  const state = sim.newGame({
    companyName: flag(args, "name") ?? "AI Test Co",
    productType: product,
    model: flag(args, "model") ?? "",
    seed,
    takeLoan: args.includes("--loan"),
    ...(flag(args, "shares") !== undefined && { shares: Number(flag(args, "shares")) }),
    gameLength: flag(args, "length"),
  });
  const game: SavedGame = { player, playstyle, seed, state };
  const row = logRow(sim, state, game, "start", {
    model: state.model,
    productType: state.productType,
    takeLoan: args.includes("--loan"),
    shares: sim.capTable(state).sharesInIssue,
    gameLength: state.gameLength,
    seed,
    ...(playstyle ? { playstyle } : {}),
  });
  writeFileSync(logPath(file), "[]");
  save(file, game, [row]);
  console.log(`${renderStatus(sim, state)}\n\n${renderCommands(sim, state)}`);
}

function play(file: string, script: string) {
  const game = load(file);
  const turn = runScript(sim, game.state, script, game);
  save(file, { ...game, state: turn.state }, turn.rows);
  console.log(`${turn.lines.join("\n")}\n\n${renderStatus(sim, turn.state)}`);
}

function main(argv: string[]) {
  const [verb, file, ...rest] = argv;
  if (!verb || !file) {
    console.log('Usage: play <new|look|do|summary> <game.json> [...]. "new" takes --product, --model, --loan, --length, --shares, --seed, --player, --playstyle.');
    process.exitCode = 1;
    return;
  }
  try {
    if (verb === "new") newGame(file, rest);
    else if (verb === "look") {
      const { state } = load(file);
      console.log(`${renderStatus(sim, state)}\n\n${state.status === "playing" ? renderCommands(sim, state) : renderSummary(sim, state)}`);
    } else if (verb === "do") play(file, rest.join(" "));
    else if (verb === "summary") console.log(renderSummary(sim, load(file).state));
    else throw new SimError("bad_command", `Unknown "${verb}": use new, look, do or summary.`);
  } catch (err) {
    if (!(err instanceof SimError)) throw err;
    console.log(`refused: ${err.message}`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
