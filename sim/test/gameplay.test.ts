import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSim, defaultConfig, FUNDER_IDS, MODEL_IDS, PRODUCT_TYPE_IDS, type DayLog, type GameState, type Sim } from "../src/index.ts";
import { playDay, STRATEGIES } from "../scripts/harness.ts";

// Gameplay fingerprints: every strategy plays every model × product for a full game on the default config, and the
// final state, summary, every day's log and the quotes a student sees along the way are hashed. Work that shouldn't
// change gameplay (a speed-up, a tidy) must leave every hash as it is. A change that's meant to alter the game updates
// them with `npx vitest run -u test/gameplay.test.ts` in sim, and the diff shows which games it touched.
const sim = createSim(defaultConfig);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** A migration quote, or why it's refused (one already under way, say). */
function quoteOrRefusal(state: GameState, target: string) {
  try {
    return sim.migrationQuote(state, target);
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * The units view without its look-ahead at servers still being set up, added for the page after these hashes were
 * taken: it plays no part in the game, so the hashes stay those of the games themselves.
 */
function withoutLookahead(units: ReturnType<Sim["units"]>) {
  if (!units) return units;
  const { loadBalancerOnceReady: _, ...rest } = units;
  return rest;
}

/** Plays one game to the end like the harness, keeping what a player would have seen on the way. */
function fingerprint(model: GameState["model"], productType: GameState["productType"], strategy: (typeof STRATEGIES)[number]) {
  const takeLoan = strategy.loan === "always" || (strategy.loan === "onprem" && model === "onprem");
  let state: GameState;
  try {
    state = sim.newGame({ companyName: "Fingerprint Ltd", productType, model, seed: 7, takeLoan });
    if (strategy.funding) {
      for (const funder of FUNDER_IDS) state = sim.applyAction(state, { type: "acceptFunding", funder });
    }
  } catch (e) {
    return `cant-start: ${(e as Error).message}`;
  }
  const logs: DayLog[] = [];
  const seen: unknown[] = [];
  while (state.status === "playing") {
    state = playDay(sim, state, strategy);
    // Every 30 days, the quotes and views a student's page asks for.
    if (state.day % 30 === 0) {
      seen.push(
        sim.pricePreview(state, Math.round(state.price * 1.25 * 100) / 100),
        quoteOrRefusal(state, state.model === "saas" ? "iaas" : "saas"),
        sim.loanQuote(state),
        withoutLookahead(sim.units(state)),
        sim.conversion(state),
        sim.events(state),
        sim.summarise(state),
        sim.valuation(state),
        sim.capTable(state),
        sim.funding(state),
        sim.ipo(state),
      );
    }
    const next = sim.advance(state);
    state = next.state;
    logs.push(...next.log);
  }
  return hash({ state, summary: sim.summarise(state), logs, seen });
}

describe("gameplay fingerprints", () => {
  it("plays every strategy, model and product to the same games as before", () => {
    const hashes: Record<string, string> = {};
    for (const strategy of STRATEGIES) {
      for (const model of MODEL_IDS) {
        for (const productType of PRODUCT_TYPE_IDS) hashes[`${strategy.id} ${model} ${productType}`] = fingerprint(model, productType, strategy);
      }
    }
    expect(hashes).toMatchSnapshot();
  }, 120_000);
});
