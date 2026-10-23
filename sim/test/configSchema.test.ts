import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  CONFIG_EXCLUSIONS,
  CONFIG_GROUPS,
  configFields,
  defaultConfig,
  diffFromDefaults,
  numericPaths,
  validateOverrides,
} from "../src/index.ts";

const fields = configFields();
const paths = new Set(fields.map((f) => f.path));

describe("config schema completeness", () => {
  // Later slices add numbers to the config: each has to be put on the config page or excluded with a reason here.
  it("lists or excludes every number in the default config", () => {
    const missing = numericPaths(defaultConfig).filter((p) => !paths.has(p) && !(p in CONFIG_EXCLUSIONS));
    expect(missing, "Add these to configFields in configSchema.ts, or to CONFIG_EXCLUSIONS with a reason").toEqual([]);
  });

  it("would catch a new number nobody listed", () => {
    const grown = { ...defaultConfig, investors: { amount: 10_000, rates: [0.05, 0.08] } };
    expect(numericPaths(grown).filter((p) => !paths.has(p) && !(p in CONFIG_EXCLUSIONS))).toEqual([
      "investors.amount",
      "investors.rates.0",
      "investors.rates.1",
    ]);
  });

  it("lists only numbers that are in the config, and none twice", () => {
    const numeric = new Set(numericPaths(defaultConfig));
    expect(fields.map((f) => f.path).filter((p) => !numeric.has(p))).toEqual([]);
    expect(paths.size).toBe(fields.length);
  });

  it("excludes only numbers that are in the config and not listed, each with a reason", () => {
    const numeric = new Set(numericPaths(defaultConfig));
    for (const [path, reason] of Object.entries(CONFIG_EXCLUSIONS)) {
      expect(numeric.has(path), path).toBe(true);
      expect(paths.has(path), path).toBe(false);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("gives every field a group, label, explanation and a range that holds its default", () => {
    for (const f of fields) {
      expect(CONFIG_GROUPS, f.path).toContain(f.group);
      expect(f.label, f.path).not.toBe("");
      expect(f.help, f.path).not.toBe("");
      expect(f.step, f.path).toBeGreaterThan(0);
      expect(f.min <= f.default && f.default <= f.max, `${f.path}: ${f.default} in ${f.min}–${f.max}`).toBe(true);
    }
  });

  it("generates fields for repeated structures, keyed by id", () => {
    expect(paths).toContain("models.iaas.monthlyCost");
    expect(paths).toContain("productTypes.video.features.hd.devDays");
    expect(paths).toContain("events.osPatch.encounter.chance");
    expect(paths).toContain("events.osPatch.encounter.risks.unpatched");
    expect(paths).toContain("encounters.riskRise.lowSatisfaction");
    expect(paths).toContain("events.osPatch.effects.onprem.shortOfOps.cost.amount");
    expect(paths).toContain("migration.phases.moving.days");
    // Only for numbers the event sets on that model, and odds it sets.
    expect(paths).not.toContain("events.osPatch.effects.paas.downtimeHours");
    expect(paths).not.toContain("events.osPatch.encounter.maxTimes");
  });

  it("takes defaults from the base config it's given", () => {
    const base = { ...defaultConfig, finalDay: 30 };
    expect(configFields(base).find((f) => f.path === "finalDay")?.default).toBe(30);
  });
});

describe("validateOverrides", () => {
  it("accepts in-range numbers on known paths", () => {
    expect(validateOverrides({ startingCash: 15_000, "models.iaas.monthlyCostPerUser": 0.25 })).toEqual({});
    expect(validateOverrides({})).toEqual({});
  });

  it("rejects each bad field with its own error", () => {
    const errors = validateOverrides({
      startingCash: -1,
      "staff.ops.dayRate": 1_000_000,
      "models.nope.monthlyCost": 5,
      "staff.developers.startingCount": 2.5,
      "outage.baseHours": "3",
      "models.iaas.name": 1,
      "models.paas.capacity": Number.NaN,
      "migration.phases.planning.days": 4,
    });
    expect(Object.keys(errors).sort()).toEqual(
      [
        "models.iaas.name",
        "models.nope.monthlyCost",
        "models.paas.capacity",
        "outage.baseHours",
        "staff.developers.startingCount",
        "staff.ops.dayRate",
        "startingCash",
      ].sort(),
    );
    expect(errors.startingCash).toMatch(/from 0 to 10,000,000/);
    expect(errors["models.nope.monthlyCost"]).toMatch(/no setting/);
    expect(errors["staff.developers.startingCount"]).toMatch(/whole number/);
    expect(errors["outage.baseHours"]).toMatch(/number/);
  });

  it("rejects anything but an object", () => {
    for (const bad of [null, 5, "x", [1]]) expect(validateOverrides(bad)).toHaveProperty([""]);
  });

  it("rejects pairs that don't fit together, on the field that changed", () => {
    expect(validateOverrides({ "migration.overrun.maxDays": 1 })).toHaveProperty(["migration.overrun.maxDays"]);
    expect(validateOverrides({ "migration.overrun.minDays": 9 })).toHaveProperty(["migration.overrun.minDays"]);
    expect(validateOverrides({ "encounters.thresholdMax": 10 })).toHaveProperty(["encounters.thresholdMax"]);
    expect(validateOverrides({ "encounters.thresholdMin": 90 })).toHaveProperty(["encounters.thresholdMin"]);
    // Every server has to fit in the biggest rack.
    expect(validateOverrides({ "models.onprem.servers.racks.serverUnits.massive": 50 })).toHaveProperty([
      "models.onprem.servers.racks.serverUnits.massive",
    ]);
    expect(validateOverrides({ "models.onprem.servers.racks.sizes.large.units": 6 })).toHaveProperty([
      "models.onprem.servers.racks.sizes.large.units",
    ]);
    expect(validateOverrides({ "models.onprem.servers.racks.serverUnits.massive": 42 })).toEqual({});
  });

  it("has a toggle for each game length, and needs at least one allowed", () => {
    const toggles = fields.filter((f) => f.kind === "toggle");
    expect(toggles.map((f) => [f.path, f.default])).toEqual([
      ["allowedGameLengths.180-days", 1],
      ["allowedGameLengths.1-year", 0],
      ["allowedGameLengths.career", 0],
    ]);
    expect(validateOverrides({ "allowedGameLengths.career": 1, "allowedGameLengths.1-year": 1 })).toEqual({});
    expect(validateOverrides({ "allowedGameLengths.career": 0.5 })).toHaveProperty(["allowedGameLengths.career"]);
    expect(validateOverrides({ "allowedGameLengths.180-days": 0 })).toEqual({
      "allowedGameLengths.180-days": "At least one game length must be allowed.",
    });
    expect(validateOverrides({ "allowedGameLengths.180-days": 0, "allowedGameLengths.career": 1 })).toEqual({});
  });
});

describe("applyOverrides and diffFromDefaults", () => {
  const overrides = {
    startingCash: 20_000,
    "models.iaas.monthlyCost": 7_000,
    "staff.developers.dayRate": 200,
    "productTypes.video.features.hd.devDays": 5,
    "events.osPatch.encounter.chance": 0.9,
    "events.providerPriceRise.effects.saas.priceRise.percent": 50,
    "events.osPatch.effects.iaas.shortOfOps.downtimeHours": 12,
  };

  it("merges overrides over the defaults without changing them", () => {
    const config = applyOverrides(overrides);
    expect(config.startingCash).toBe(20_000);
    expect(config.models.iaas.monthlyCost).toBe(7_000);
    expect(config.models.iaas.upfrontCost).toBe(defaultConfig.models.iaas.upfrontCost);
    expect(config.staff.developers.dayRate).toBe(200);
    expect(config.productTypes.video.features.find((f) => f.id === "hd")?.devDays).toBe(5);
    expect(config.events.find((e) => e.id === "osPatch")?.encounter).toEqual({ chance: 0.9, risks: { unpatched: 1.6 } });
    expect(config.events.find((e) => e.id === "providerPriceRise")?.effects.saas?.priceRise).toEqual({
      percent: 50,
      addons: true,
    });
    expect(config.events.find((e) => e.id === "osPatch")?.effects.iaas?.shortOfOps?.downtimeHours).toBe(12);
    // The defaults are untouched.
    expect(defaultConfig.startingCash).toBe(15_000);
    expect(defaultConfig.events.find((e) => e.id === "osPatch")?.encounter?.chance).toBe(0.5);
  });

  it("round-trips: the diff of the merged config is the overrides", () => {
    expect(diffFromDefaults(applyOverrides(overrides))).toEqual(overrides);
    expect(diffFromDefaults(defaultConfig)).toEqual({});
  });

  it("drops overrides equal to the default from the diff", () => {
    expect(diffFromDefaults(applyOverrides({ startingCash: defaultConfig.startingCash }))).toEqual({});
  });

  it("diffs against the base it's given", () => {
    const base = { ...defaultConfig, finalDay: 30 };
    expect(diffFromDefaults(applyOverrides({ startingCash: 1_000 }, base), base)).toEqual({ startingCash: 1_000 });
    expect(diffFromDefaults(base)).toEqual({ finalDay: 30 });
  });

  it("throws on a path that isn't in the config", () => {
    expect(() => applyOverrides({ "models.nope.monthlyCost": 1 })).toThrow(/Unknown/);
  });
});
