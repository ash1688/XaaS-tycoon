import { CUSTOMER_TYPE_IDS, type CustomerTypeId, type FeatureConfig, type GameConfig, type ModelId } from "./config.ts";
import { count, pounds, risen, type Finance } from "./finance.ts";
import { staffOutput } from "./staff.ts";
import { SimError, type FeatureProgress, type GameState, type LogEntry } from "./state.ts";

export type FeatureStatus = "notStarted" | FeatureProgress["status"];

/** A feature on the product's list, and how far it has got. */
export interface FeatureView extends FeatureConfig {
  status: FeatureStatus;
  /** Developer-days done so far. */
  progress: number;
  /** Days until a build finishes at today's developers. Null unless building, with no developers, or paused on SaaS. */
  daysLeft: number | null;
  /** On SaaS, the one-off fee to set it up as an add-on, on top of its per-user price. */
  addonSetupFee: number;
}

/** Features and add-ons: building them in developer-days, buying them on SaaS, and billing the add-ons. */
export function createFeatures(config: GameConfig, finance: Finance) {
  const featureList = (state: GameState) => config.productTypes[state.productType].features;

  /** The one-off fee to set an add-on up: its developer-days × setupFeePerDevDay, after any provider price rise. */
  const setupFee = (state: GameState, f: FeatureConfig) =>
    Math.round(risen(f.devDays * config.addons.setupFeePerDevDay, state.addonPriceRise));

  const isActive = (state: GameState, id: string) => {
    const status = state.features[id]?.status;
    return status === "built" || status === "addon";
  };

  /** The feature being built, if any. Only one is built at a time. */
  function currentBuild(state: GameState): FeatureConfig | undefined {
    return featureList(state).find((f) => state.features[f.id]?.status === "building");
  }

  function startBuild(state: GameState, id: string): GameState {
    if (state.model === "saas") {
      throw new SimError(
        "saas_features",
        "On SaaS you don't build features yourself: they come as add-ons from the provider.",
      );
    }
    const feature = featureList(state).find((f) => f.id === id);
    if (!feature) throw new SimError("unknown_feature", "Pick a feature from your product's list.");
    if (state.mvp.doneDay === null) {
      throw new SimError("mvp_first", `Your developers are building the MVP. ${feature.name} can be started once it's done.`);
    }
    const existing = state.features[id];
    if (isActive(state, id)) throw new SimError("feature_built", `${feature.name} is already built.`);
    if (existing) throw new SimError("feature_building", `${feature.name} is already being built.`);
    const building = currentBuild(state);
    if (building) {
      throw new SimError("build_in_progress", `Your developers are busy building ${building.name}. Finish that first.`);
    }
    return { ...state, features: { ...state.features, [id]: { status: "building", progress: 0 } } };
  }

  function buyAddon(state: GameState, id: string): GameState {
    if (state.model !== "saas") {
      throw new SimError("not_saas", "Add-ons are only sold on SaaS. On your model, your developers build features.");
    }
    const feature = featureList(state).find((f) => f.id === id);
    if (!feature) throw new SimError("unknown_feature", "Pick a feature from your product's list.");
    if (isActive(state, id)) throw new SimError("addon_active", `${feature.name} is already active.`);
    const needed = config.addons.minConfigDevelopers;
    if (staffOutput(config, state, "developers") < needed) {
      throw new SimError(
        "config_team",
        `Add-ons still need configuring: hire at least ${needed} developer${needed === 1 ? "" : "s"} first, counted in mids: juniors do less, seniors more.`,
      );
    }
    // Paid when it's bought: the provider's fee to set it up.
    const fee = setupFee(state, feature);
    if (fee > state.cash) {
      throw new SimError("cant_afford", `Setting up ${feature.name} costs ${pounds(fee)} and you have ${pounds(state.cash)}.`, {
        cost: fee,
        cash: state.cash,
      });
    }
    const bought: GameState = { ...state, features: { ...state.features, [id]: { status: "addon", progress: 0 } } };
    if (fee <= 0) return bought;
    return finance.chargeNow(bought, [{ text: `Add-on set-up: ${feature.name}`, cashDelta: -fee, category: "addons" }]);
  }

  /**
   * A day's work on the current build: the developers' output, a developer-day for each mid. Logs progress, or completion. A build is
   * paused on SaaS (it only gets there by migrating mid-build).
   */
  function buildDay(state: GameState): { features: GameState["features"]; entries: LogEntry[] } {
    const feature = currentBuild(state);
    if (!feature || state.model === "saas") return { features: state.features, entries: [] };
    const work = staffOutput(config, state, "developers");
    if (work === 0) {
      const text = `${feature.name}: no developers, so no progress today.`;
      return { features: state.features, entries: [{ text, cashDelta: 0, kind: "feature" }] };
    }
    const progress = Math.min(feature.devDays, Math.round((state.features[feature.id]!.progress + work) * 100) / 100);
    const built = progress === feature.devDays;
    const percent = Math.round(100 * (feature.growthMultiplier - 1));
    const text = built
      ? `Feature built: ${feature.name}. Growth up ${percent}% from now on.`
      : `Building ${feature.name}: ${+progress.toFixed(1)} of ${feature.devDays} developer-days done.`;
    return {
      features: { ...state.features, [feature.id]: { status: built ? "built" : "building", progress } },
      entries: [{ text, cashDelta: 0, kind: "feature" }],
    };
  }

  function features(state: GameState): FeatureView[] {
    return featureList(state).map((f) => {
      const { status, progress } = state.features[f.id] ?? { status: "notStarted" as const, progress: 0 };
      const work = staffOutput(config, state, "developers");
      const daysLeft = status === "building" && work > 0 && state.model !== "saas" ? Math.ceil((f.devDays - progress) / work) : null;
      return { ...f, status, progress, daysLeft, addonSetupFee: setupFee(state, f) };
    });
  }

  /** Growth multipliers from each feature built before today, and each add-on bought. */
  const activeGrowth = (state: GameState) =>
    featureList(state)
      .filter((f) => isActive(state, f.id))
      .map((f) => f.growthMultiplier);

  /**
   * What the active features do to who joins: each customer type's weight among new users is multiplied by every
   * active feature's appeal to it. 1 for a type no active feature appeals to.
   */
  function appeal(state: GameState): Record<CustomerTypeId, number> {
    const active = featureList(state).filter((f) => isActive(state, f.id));
    const by = (t: CustomerTypeId) => active.reduce((m, f) => m * (f.appeal?.[t] ?? 1), 1);
    return Object.fromEntries(CUSTOMER_TYPE_IDS.map((t) => [t, by(t)])) as Record<CustomerTypeId, number>;
  }

  /** Features built before today and add-ons bought: what's active for customers. */
  const activeCount = (state: GameState) => featureList(state).filter((f) => isActive(state, f.id)).length;

  const activeAddons = (state: GameState) => featureList(state).filter((f) => state.features[f.id]?.status === "addon");

  /** The add-ons a migration to this model would leave behind: all of them when leaving SaaS, none otherwise. */
  const addonsLeftBehind = (state: GameState, to: ModelId) =>
    state.model === "saas" && to !== "saas" ? activeAddons(state) : [];

  /** Each active add-on's per-user price on the given users, billed like the model's per-user fee, after price rises. */
  function addonEntries(state: GameState, days = 1): LogEntry[] {
    const share = days / config.billing.daysPerMonth;
    return activeAddons(state).map((f) => {
      const price = risen(f.addonPricePerUser, state.addonPriceRise);
      return {
        text: `Add-on: ${f.name} (${count.format(state.users)} users at ${pounds(price)} a month)`,
        cashDelta: -Math.round(state.users * price * share),
        category: "addons",
      };
    });
  }

  /** What the active add-ons cost a day at today's users, as billed. */
  const dailyAddonCost = (state: GameState) => -addonEntries(state).reduce((sum, e) => sum + e.cashDelta, 0);

  function monthlyAddonCost(state: GameState): number {
    const perUser = activeAddons(state).reduce((sum, f) => sum + risen(f.addonPricePerUser, state.addonPriceRise), 0);
    return Math.round(state.users * perUser);
  }

  return {
    currentBuild,
    startBuild,
    buyAddon,
    buildDay,
    features,
    activeGrowth,
    appeal,
    activeCount,
    addonsLeftBehind,
    addonEntries,
    dailyAddonCost,
    monthlyAddonCost,
  };
}

export type Features = ReturnType<typeof createFeatures>;
