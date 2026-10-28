import { cuDemand } from "./benefits.ts";
import type { GameConfig, ModelId } from "./config.ts";
import type { GameState } from "./state.ts";

/** Optimisation's view, for the features panel after launch. */
export interface OptimisationView {
  /** The slider: the share of developer output going into optimisation rather than features (0–1). */
  share: number;
  /** Optimisation developer-days built up so far, kept through migrations. */
  days: number;
  /** The share of resource need per user saved today, on the current model: at most its cap. */
  saving: number;
  /** The most optimisation can ever save on the current model. */
  cap: number;
  /** Developer-days a day going into optimisation at today's developers and slider: 0 until the MVP is done. */
  output: number;
  /** The saving has all but reached its cap (AT_CAP of it): more optimisation gains next to nothing. */
  atCap: boolean;
}

/** The share of its cap at which optimisation's saving counts as at its cap: more work gains next to nothing. */
export const AT_CAP = 0.95;

/** Whether optimisation's saving has all but reached its cap on the company's model. */
export const optimisationAtCap = (config: GameConfig, state: Pick<GameState, "model" | "optimisationDays">) =>
  optimisationSaving(config, state.optimisationDays, state.model) >= AT_CAP * config.optimisation.cap[state.model];

/** Developer-days rounded to the hundredth, so state stays tidy. */
const tidy = (n: number) => Math.round(n * 100) / 100;

/**
 * The share of resource need per user that optimisation days save on a model: cap × (1 − e^(−days ÷ k)). Quick gains at
 * first, flattening out under the model's cap. The days are the company's code, so they count on whatever model it's on.
 */
export function optimisationSaving(config: GameConfig, days: number, model: ModelId): number {
  const { k, cap } = config.optimisation;
  if (days <= 0) return 0;
  if (k <= 0) return cap[model];
  return cap[model] * (1 - Math.exp(-days / k));
}

/** What's left of resource need per user after optimisation on a model: 1 − the saving. */
export const optimisedShare = (config: GameConfig, state: Pick<GameState, "optimisationDays">, model: ModelId) =>
  1 - optimisationSaving(config, state.optimisationDays, model);

/**
 * CU and DBU each user needs on a model, after optimisation: the product's demand per user × what optimisation leaves.
 * Fewer per user means fewer servers (and so fewer ops) on-prem and on IaaS, and fewer instances on PaaS. A model
 * benefit (a CDN) can take some CU off on top.
 */
export function demandPerUser(
  config: GameConfig,
  state: Pick<GameState, "productType" | "optimisationDays" | "benefits" | "model">,
  model: ModelId,
): { cuPerUser: number; dbuPerUser: number } {
  const { cuPerUser, dbuPerUser } = config.productTypes[state.productType].demand;
  const left = optimisedShare(config, state, model);
  return { cuPerUser: cuPerUser * left * cuDemand(config, state, model), dbuPerUser: dbuPerUser * left };
}

/**
 * Optimisation's share of the developers' output: the slider's, once the MVP is done (before then it all goes into the
 * MVP). The rest goes into the current feature build.
 */
export const optimisationOutput = (state: Pick<GameState, "optimisationShare">, output: number, mvpDone: boolean) =>
  mvpDone ? output * state.optimisationShare : 0;

/** A day's optimisation: its share of the developers' output, built up. Nothing until the MVP is done. */
export function optimisationDay(state: Pick<GameState, "optimisationDays" | "optimisationShare">, output: number, mvpDone: boolean): number {
  return tidy(state.optimisationDays + optimisationOutput(state, output, mvpDone));
}

export function optimisationView(
  config: GameConfig,
  state: Pick<GameState, "model" | "optimisationDays" | "optimisationShare" | "mvp">,
  output: number,
): OptimisationView {
  return {
    share: state.optimisationShare,
    days: state.optimisationDays,
    saving: optimisationSaving(config, state.optimisationDays, state.model),
    cap: config.optimisation.cap[state.model],
    output: optimisationOutput(state, output, state.mvp.doneDay !== null),
    atCap: optimisationAtCap(config, state),
  };
}
