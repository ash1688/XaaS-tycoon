import { CUSTOMER_TYPE_IDS, type CustomerTypeId, type FeatureConfig, type GameConfig, type ModelId, type TierNumber } from "./config.ts";
import { count, pounds, risen, type Finance } from "./finance.ts";
import { staffOutput } from "./staff.ts";
import { SimError, type FeatureProgress, type GameState, type LogEntry } from "./state.ts";
import { featureTier, isUnlocked, itemRpPrice, lockedMessage, tierAvailable } from "./tiers.ts";

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
  /** The tier it's in. */
  tier: TierNumber;
  /** Research points (RP) to unlock it: 0 in tier 1. */
  rpPrice: number;
  /** Its tier's condition is met, so it can be unlocked with RP if it isn't already. */
  tierAvailable: boolean;
  /** In tier 1, or unlocked with RP, so it can be built or bought. */
  unlocked: boolean;
}

/** Features and add-ons: building them in developer-days, buying them on SaaS, and billing the add-ons. */
export function createFeatures(config: GameConfig, finance: Finance) {
  const featureList = (state: GameState) => config.productTypes[state.productType].features;

  /** The one-off fee to set an add-on up: its developer-days × setupFeePerDevDay, after any provider price rise. */
  const setupFee = (state: GameState, f: FeatureConfig) =>
    Math.round(risen(f.devDays * config.addons.setupFeePerDevDay, state.addonPriceRise * state.priceLevel));

  /**
   * The developer-days a feature takes to build: its devDays, × tiers.tier1BuildMultiplier in tier 1, which opens at
   * Launch without research (#263), so early features aren't cheap. An add-on's set-up fee goes by its devDays alone.
   */
  const buildDays = (f: FeatureConfig) => Math.round(f.devDays * (featureTier(f) === 1 ? config.tiers.tier1BuildMultiplier : 1));

  const isActive = (state: GameState, id: string) => {
    const status = state.features[id]?.status;
    return status === "built" || status === "addon";
  };

  /**
   * The developers' output going into features, in developer-days a day: what the developer slider leaves after
   * optimisation (see Optimisation). A build can only be under way once the MVP is done.
   */
  const featureOutput = (state: GameState) => staffOutput(config, state, "developers") * (1 - state.optimisationShare);

  /** Refuses a feature that isn't unlocked yet. One already started or active is never refused. */
  function refuseLocked(state: GameState, feature: FeatureConfig) {
    if (!isUnlocked(config, state, feature.id)) {
      throw new SimError("locked", lockedMessage(config, state, feature.id));
    }
  }

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
    if (!feature) unknownFeature(id);
    refuseLocked(state, feature);
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

  /** Refuses an id that isn't one of the product's features, pointing a model benefit's id at `benefit`. */
  function unknownFeature(id: string): never {
    const benefit = config.tiers.benefits.find((b) => b.id.toLowerCase() === id.toLowerCase());
    if (benefit) {
      const model = { onprem: "on-prem", iaas: "IaaS", paas: "PaaS", saas: "SaaS" }[benefit.model];
      throw new SimError("unknown_feature", `${benefit.name} is a ${model} model benefit, not a feature: buy it as a benefit.`);
    }
    throw new SimError("unknown_feature", "Pick a feature from your product's list.");
  }

  function buyAddon(state: GameState, id: string): GameState {
    if (state.model !== "saas") {
      throw new SimError("not_saas", "Add-ons are only sold on SaaS. On your model, your developers build features.");
    }
    const feature = featureList(state).find((f) => f.id === id);
    if (!feature) unknownFeature(id);
    if (isActive(state, id)) throw new SimError("addon_active", `${feature.name} is already active.`);
    refuseLocked(state, feature);
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
   * A day's work on the current build: the developers' output, a developer-day for each mid, less the slider's share
   * going into optimisation. Logs progress, or completion. A build is paused on SaaS (it only gets there by migrating
   * mid-build).
   */
  function buildDay(state: GameState): { features: GameState["features"]; entries: LogEntry[] } {
    const feature = currentBuild(state);
    if (!feature || state.model === "saas") return { features: state.features, entries: [] };
    const work = featureOutput(state);
    if (work === 0) {
      const text =
        staffOutput(config, state, "developers") > 0
          ? `${feature.name}: your developers are all on optimisation, so no progress today.`
          : `${feature.name}: no developers, so no progress today.`;
      return { features: state.features, entries: [{ text, cashDelta: 0, kind: "feature" }] };
    }
    const total = buildDays(feature);
    const progress = Math.min(total, Math.round((state.features[feature.id]!.progress + work) * 100) / 100);
    const built = progress === total;
    const percent = Math.round(100 * (feature.growthMultiplier - 1));
    const text = built
      ? `Feature built: ${feature.name}. Growth up ${percent}% from now on.`
      : `Building ${feature.name}: ${+progress.toFixed(1)} of ${total} developer-days done.`;
    return {
      features: { ...state.features, [feature.id]: { status: built ? "built" : "building", progress } },
      entries: [{ text, cashDelta: 0, kind: "feature" }],
    };
  }

  function features(state: GameState): FeatureView[] {
    return featureList(state).map((f) => {
      const { status, progress } = state.features[f.id] ?? { status: "notStarted" as const, progress: 0 };
      const work = featureOutput(state);
      const daysLeft = status === "building" && work > 0 && state.model !== "saas" ? Math.ceil((buildDays(f) - progress) / work) : null;
      return {
        ...f,
        devDays: buildDays(f),
        status,
        progress,
        daysLeft,
        addonSetupFee: setupFee(state, f),
        tier: featureTier(f),
        rpPrice: itemRpPrice(config, state, f.id),
        tierAvailable: tierAvailable(state, featureTier(f)),
        unlocked: isUnlocked(config, state, f.id),
      };
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
    state.model === "saas" && to !== "saas" ? activeAddons(state).map((f) => ({ ...f, devDays: buildDays(f) })) : [];

  /** Each active add-on's per-user price on the given users, billed like the model's per-user fee, after price rises. */
  function addonEntries(state: GameState, days = 1): LogEntry[] {
    const share = days / config.billing.daysPerMonth;
    return activeAddons(state).map((f) => {
      const price = risen(f.addonPricePerUser, state.addonPriceRise * state.priceLevel);
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
    const perUser = activeAddons(state).reduce((sum, f) => sum + risen(f.addonPricePerUser, state.addonPriceRise * state.priceLevel), 0);
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
