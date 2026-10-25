import type { GameConfig } from "./config.ts";
import type { GameState } from "./state.ts";

/** The most Campaigns can add to the product's market: marketGrowthCap of its base size, to the whole user. */
export const marketGrowthCap = (config: GameConfig, state: Pick<GameState, "productType">) =>
  Math.floor(config.campaigns.marketGrowthCap * config.productTypes[state.productType].growth.marketSize);

/** What Campaigns have added to the product's market so far (brand awareness): it stays for good. */
export const marketGrowth = (state: Pick<GameState, "campaigns">) =>
  Math.round(state.campaigns.reduce((sum, c) => sum + c.marketAdded, 0) * 1e6) / 1e6;

/**
 * The users the product can reach: its base market size, plus what Campaigns have added. Growth, event waves and the
 * angel's users target all slow as users approach it.
 */
export const marketSize = (config: GameConfig, state: Pick<GameState, "productType" | "campaigns">) =>
  config.productTypes[state.productType].growth.marketSize + marketGrowth(state);
