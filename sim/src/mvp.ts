import type { GameConfig, ModelId, ProductTypeId } from "./config.ts";
import type { LogEntry, MvpProgress } from "./state.ts";

/** What the MVP needs to know about the company on a day. */
export interface MvpInput {
  productType: ProductTypeId;
  model: ModelId;
  mvp: MvpProgress;
  /** The developers' output a day, in developer-days: a developer-day for each mid, agency staff included. */
  output: number;
  /** The day just played. */
  day: number;
}

/** The MVP's progress, for the features panel before launch. */
export interface MvpView {
  /** Developer-days done so far. */
  progress: number;
  /** Developer-days it takes on this product and model. */
  total: number;
  done: boolean;
  /** The day it was finished, or null until then. */
  doneDay: number | null;
  /** Developer-days a day going into it at today's developers. */
  output: number;
  /** Days of work left at today's developers: 0 once done, null with no developers. */
  daysLeft: number | null;
  /**
   * The day it was or, at today's developers, will be finished: Launch can be pressed once it's played, for go-live the
   * day after. Null with no developers to finish it.
   */
  launchDay: number | null;
}

/** Developer-days rounded to the hundredth, so state stays tidy. */
const tidy = (n: number) => Math.round(n * 100) / 100;

/** The MVP's size: the product's base developer-days × the model's share of the stack it builds. */
export function mvpSize(config: GameConfig, productType: ProductTypeId, model: ModelId): number {
  return tidy(Math.max(0, config.mvp.baseDevDays[productType] * config.mvp.modelShare[model]));
}

/** A new company's MVP: nothing done, or done already (on day 1) if a config makes it no size at all. */
export function startingMvp(config: GameConfig, productType: ProductTypeId, model: ModelId): MvpProgress {
  return { progress: 0, doneDay: mvpSize(config, productType, model) <= 0 ? 1 : null };
}

/** Whether the MVP is done by the end of `day`. */
export const mvpDoneBy = (mvp: MvpProgress, day: number) => mvp.doneDay !== null && mvp.doneDay <= day;

export function mvpStatus(config: GameConfig, { productType, model, mvp, output, day }: MvpInput): MvpView {
  const total = mvpSize(config, productType, model);
  const done = mvp.doneDay !== null;
  const left = Math.max(0, total - mvp.progress);
  const daysLeft = done ? 0 : output > 0 ? Math.ceil(tidy(left / output)) : null;
  const launchDay = done ? mvp.doneDay : daysLeft === null ? null : day + daysLeft;
  return { progress: mvp.progress, total, done, doneDay: mvp.doneDay, output, daysLeft, launchDay };
}

/**
 * A day's work on the MVP: all the developers' output goes into it until it's done, logged. Nothing once it's done.
 * Finishes too if it's already big enough, say after migrating to a model with a smaller one.
 */
export function mvpDay(config: GameConfig, input: MvpInput): { mvp: MvpProgress; entries: LogEntry[] } {
  const { mvp, output, day } = input;
  if (mvp.doneDay !== null) return { mvp, entries: [] };
  const total = mvpSize(config, input.productType, input.model);
  const progress = Math.min(total, tidy(mvp.progress + output));
  if (progress >= total) {
    // What developers can do now (#263): optimisation straight away, tier 1 from Launch, the tiers above in Grow.
    const tier1 = input.model === "saas" ? "you can buy tier 1 add-ons for them to set up" : "they can build tier 1 features";
    const text =
      "MVP done: press Launch when you're set up, and your first users start arriving. " +
      `Until then your developers can work on optimisation (the developer slider); from Launch ${tier1}. Research opens the higher tiers in the Grow phase.`;
    return { mvp: { progress, doneDay: day }, entries: [{ text, cashDelta: 0, kind: "launch" }] };
  }
  const text =
    output > 0
      ? `Building the MVP: ${+progress.toFixed(1)} of ${total} developer-days done.`
      : "MVP: no developers, so no progress today.";
  return { mvp: { progress, doneDay: null }, entries: [{ text, cashDelta: 0, kind: "feature" }] };
}
