import type { GameConfig, ModelBenefitConfig, ModelBenefitEffects, ModelId, TierNumber } from "./config.ts";
import { pounds, risen, type Finance } from "./finance.ts";
import { isUnlocked, itemRpPrice, lockedMessage, tierAvailable } from "./tiers.ts";
import { SimError, type GameState, type LogEntry } from "./state.ts";

/** A model benefit, for the screen: every model's, so the student sees what the others offer. */
export interface BenefitView {
  id: string;
  name: string;
  blurb: string;
  model: ModelId;
  tier: TierNumber;
  setupFee: number;
  monthlyFee: number;
  /** Research points (RP) to unlock it: 0 in tier 1. */
  rpPrice: number;
  /** Its tier's condition is met, so it can be unlocked with RP if it isn't already. */
  tierAvailable: boolean;
  /** Unlocked with RP (or in tier 1), so it can be bought on its model. Unlocks are kept through a migration. */
  unlocked: boolean;
  /** It belongs to the company's current model, so it can be bought here. */
  onModel: boolean;
  /** Bought and on. */
  active: boolean;
}

/** The benefits on for a model: those the company has bought, while it's on that model. None on any other. */
function activeOn(config: GameConfig, state: Pick<GameState, "benefits" | "model">, model: ModelId): ModelBenefitConfig[] {
  if (model !== state.model) return [];
  return config.tiers.benefits.filter((b) => b.model === model && state.benefits.includes(b.id));
}

/** Every active benefit's effect of one kind on a model, for adding up or multiplying together. */
function effectsOn<K extends keyof ModelBenefitEffects>(
  config: GameConfig,
  state: Pick<GameState, "benefits" | "model">,
  model: ModelId,
  key: K,
): NonNullable<ModelBenefitEffects[K]>[] {
  return activeOn(config, state, model).flatMap((b) => (b.effects[key] === undefined ? [] : [b.effects[key]!]));
}

const product = (list: number[]) => list.reduce((m, x) => m * x, 1);
const savingOf = (list: number[]) => Math.min(1, list.reduce((a, b) => a + b, 0));

type BenefitState = Pick<GameState, "benefits" | "model">;

/** The share off power and cooling and servers' power and upkeep on a model (hardware efficiency). */
export const powerSaving = (config: GameConfig, state: BenefitState, model: ModelId) =>
  savingOf(effectsOn(config, state, model, "powerSaving"));

/** The share off servers' rent on a model (reserved instances). */
export const rentSaving = (config: GameConfig, state: BenefitState, model: ModelId) =>
  savingOf(effectsOn(config, state, model, "rentSaving"));

/** What the hardware slider's risks are multiplied by on a model. */
export const sliderRisk = (config: GameConfig, state: BenefitState, model: ModelId) =>
  product(effectsOn(config, state, model, "sliderRisk"));

/** What CU demand is multiplied by on a model (a CDN). */
export const cuDemand = (config: GameConfig, state: BenefitState, model: ModelId) =>
  product(effectsOn(config, state, model, "cuDemand"));

/** What every outage's hours are multiplied by on a model (managed monitoring). */
export const outageHours = (config: GameConfig, state: BenefitState, model: ModelId) =>
  product(effectsOn(config, state, model, "outageHours"));

/** What an event's hours down are multiplied by on a model (a provider support plan). */
export const eventHours = (config: GameConfig, state: BenefitState, model: ModelId, event: string) =>
  product(effectsOn(config, state, model, "eventHours").filter((e) => e.events.includes(event)).map((e) => e.multiplier));

/** Autoscaling on a model, if it's on: extra VMs for demand over capacity. */
export const autoscaling = (config: GameConfig, state: BenefitState, model: ModelId) =>
  effectsOn(config, state, model, "autoscaling")[0];

/** Managed autoscaling on a model, if it's on: the platform sets the instance count each night. */
export const managedAutoscaling = (config: GameConfig, state: BenefitState, model: ModelId) =>
  effectsOn(config, state, model, "managedAutoscaling")[0];

/** Model benefits: buying them once their tier is unlocked, cancelling them, and billing them monthly. */
export function createBenefits(config: GameConfig, finance: Finance) {
  const find = (id: string) => config.tiers.benefits.find((b) => b.id === id);

  function buyBenefit(state: GameState, id: string): GameState {
    const benefit = find(id);
    if (!benefit) throw new SimError("unknown_benefit", "Pick a model benefit from the list.");
    const here = config.models[state.model].name;
    if (benefit.model !== state.model) {
      const its = config.models[benefit.model].name;
      throw new SimError("wrong_model", `${benefit.name} is a benefit of ${its}, and you're on ${here}.`);
    }
    if (state.benefits.includes(id)) throw new SimError("benefit_active", `${benefit.name} is already on.`);
    if (!isUnlocked(config, state, id)) throw new SimError("locked", lockedMessage(config, state, id));
    const setupFee = drifted(state, benefit.setupFee);
    if (setupFee > state.cash) {
      throw new SimError(
        "cant_afford",
        `Setting up ${benefit.name} costs ${pounds(setupFee)} and you have ${pounds(state.cash)}.`,
        { cost: setupFee, cash: state.cash },
      );
    }
    const bought: GameState = { ...state, benefits: [...state.benefits, id] };
    if (setupFee <= 0) return bought;
    return finance.chargeNow(bought, [
      { text: `Model benefit set-up: ${benefit.name}`, cashDelta: -setupFee, category: "infrastructure" },
    ]);
  }

  /** A benefit's fee after drift's price level from the years' ends so far. */
  const drifted = (state: GameState, fee: number) => risen(fee, state.priceLevel);

  function cancelBenefit(state: GameState, id: string): GameState {
    const benefit = find(id);
    if (!benefit) throw new SimError("unknown_benefit", "Pick a model benefit from the list.");
    if (!state.benefits.includes(id)) throw new SimError("benefit_not_active", `${benefit.name} isn't on.`);
    return { ...state, benefits: state.benefits.filter((b) => b !== id) };
  }

  /** Each benefit on's monthly fee for some days, as infrastructure, rounded to the pound like the model's own bill. */
  function benefitEntries(state: GameState, days = 1): LogEntry[] {
    const share = days / config.billing.daysPerMonth;
    return activeOn(config, state, state.model)
      .filter((b) => b.monthlyFee > 0)
      .map((b) => ({
        text: `Model benefit: ${b.name} (${pounds(drifted(state, b.monthlyFee))} a month)`,
        cashDelta: -Math.round(drifted(state, b.monthlyFee) * share),
        category: "infrastructure" as const,
      }));
  }

  const monthlyBenefitCost = (state: GameState) =>
    activeOn(config, state, state.model).reduce((sum, b) => sum + drifted(state, b.monthlyFee), 0);

  /** The benefits a migration to another model would lose: every one that's on. */
  const benefitsLostTo = (state: GameState, to: ModelId) => (to === state.model ? [] : activeOn(config, state, state.model));

  function benefits(state: GameState): BenefitView[] {
    return config.tiers.benefits.map((b) => ({
      id: b.id,
      name: b.name,
      blurb: b.blurb,
      model: b.model,
      tier: b.tier,
      setupFee: drifted(state, b.setupFee),
      monthlyFee: drifted(state, b.monthlyFee),
      rpPrice: itemRpPrice(config, state, b.id),
      tierAvailable: tierAvailable(state, b.tier),
      unlocked: isUnlocked(config, state, b.id),
      onModel: b.model === state.model,
      active: state.benefits.includes(b.id) && b.model === state.model,
    }));
  }

  return { buyBenefit, cancelBenefit, benefitEntries, monthlyBenefitCost, benefitsLostTo, benefits };
}

export type Benefits = ReturnType<typeof createBenefits>;
