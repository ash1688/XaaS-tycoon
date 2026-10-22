// The AI playtest command line: play one game of XaaS Tycoon as text, a few commands at a time. The game is saved to
// a JSON file between calls, and every game writes a playtest log beside it (<game>.log.json) in the classroom
// export's format. See textPlay.ts.
//
//   npm run play -- new <game.json> --product social --model paas [--loan] [--shares 10000] [--seed 1] [--player "AI 1"] [--playstyle min-maxer]
//   npm run play -- look <game.json>
//   npm run play -- do <game.json> "hire support 3; price 6; next 7"
//   npm run play -- summary <game.json>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createSim, SimError, type GameState } from "../src/index.ts";
import {
  advanceUntil,
  logRow,
  parseCommand,
  renderCommands,
  renderStatus,
  renderSummary,
  runCommand,
  type LogRow,
  type Player,
} from "./textPlay.ts";

interface SavedGame extends Player {
  seed: number;
  state: GameState;
}

const sim = createSim();
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

function newGame(file: string, args: string[]) {
  const seed = Number(flag(args, "seed") ?? Math.floor(Math.random() * 1_000_000));
  const player = flag(args, "player") ?? "AI playtester";
  const playstyle = flag(args, "playstyle");
  const state = sim.newGame({
    companyName: flag(args, "name") ?? "AI Test Co",
    productType: flag(args, "product") ?? "",
    model: flag(args, "model") ?? "",
    seed,
    takeLoan: args.includes("--loan"),
    ...(flag(args, "shares") !== undefined && { shares: Number(flag(args, "shares")) }),
  });
  const game: SavedGame = { player, playstyle, seed, state };
  const row = logRow(sim, state, game, "start", {
    model: state.model,
    productType: state.productType,
    takeLoan: args.includes("--loan"),
    shares: sim.capTable(state).sharesInIssue,
    seed,
    ...(playstyle ? { playstyle } : {}),
  });
  writeFileSync(logPath(file), "[]");
  save(file, game, [row]);
  console.log(`${renderStatus(sim, state)}\n\n${renderCommands(sim, state)}`);
}

function play(file: string, script: string) {
  const game = load(file);
  let state = game.state;
  const rows: LogRow[] = [];
  const out: string[] = [];
  for (const text of script.split(";").map((t) => t.trim()).filter(Boolean)) {
    try {
      const command = parseCommand(text);
      // Once the game is over, only what changes nothing still works: the valuation and who owns the company.
      if (state.status !== "playing" && command.kind !== "valuation" && command.kind !== "funding") {
        out.push(`> ${text}: the game is over`);
        break;
      }
      const turn = command.kind === "next" ? advanceUntil(sim, state, command.days, game) : runCommand(sim, state, command, game);
      state = turn.state;
      rows.push(...turn.rows);
      out.push(`> ${text}`, ...turn.lines);
      // An advance that stopped early leaves the rest of the script unplayed: the player should look first.
      if (command.kind === "next" && turn.lines.at(-1)?.startsWith("stopped")) {
        out.push("(rest of the commands skipped: something needs a decision)");
        break;
      }
    } catch (err) {
      if (!(err instanceof SimError)) throw err;
      out.push(`> ${text}`, `refused: ${err.message}`);
    }
  }
  save(file, { ...game, state }, rows);
  console.log(`${out.join("\n")}\n\n${renderStatus(sim, state)}`);
}

function main(argv: string[]) {
  const [verb, file, ...rest] = argv;
  if (!verb || !file) {
    console.log('Usage: play <new|look|do|summary> <game.json> [...]. "new" takes --product, --model, --loan, --shares, --seed, --player, --playstyle.');
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
