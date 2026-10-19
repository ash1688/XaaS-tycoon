import { describe, expect, it } from "vitest";
import { MODEL_IDS, responsibilityStack, type ModelId, type Owner } from "../src/index.ts";

const owners = (model: ModelId) => Object.fromEntries(responsibilityStack(model).map((l) => [l.id, l.owner]));

// The table from the design notes, row by row.
const expected: Record<string, Record<ModelId, Owner>> = {
  facilities: { onprem: "you", iaas: "provider", paas: "provider", saas: "provider" },
  hardware: { onprem: "you", iaas: "provider", paas: "provider", saas: "provider" },
  os: { onprem: "you", iaas: "you", paas: "provider", saas: "provider" },
  runtime: { onprem: "you", iaas: "you", paas: "provider", saas: "provider" },
  application: { onprem: "you", iaas: "you", paas: "you", saas: "shared" },
  data: { onprem: "you", iaas: "you", paas: "you", saas: "you" },
};

describe("responsibilityStack", () => {
  it.each(MODEL_IDS)("matches the design notes for %s", (model) => {
    const want = Object.fromEntries(Object.entries(expected).map(([layer, byModel]) => [layer, byModel[model]]));
    expect(owners(model)).toEqual(want);
  });

  it("lists layers bottom to top with display names", () => {
    expect(responsibilityStack("iaas").map((l) => l.name)).toEqual([
      "Building, power, cooling",
      "Hardware",
      "OS and patching",
      "Runtime and scaling",
      "Application / features",
      "Data and users",
    ]);
  });

  it("always leaves data and users with you", () => {
    for (const model of MODEL_IDS) expect(owners(model).data).toBe("you");
  });

  it("hands you fewer layers as you move from on-prem to SaaS", () => {
    const yours = MODEL_IDS.map((m) => responsibilityStack(m).filter((l) => l.owner === "you").length);
    expect(yours).toEqual([6, 4, 2, 1]);
  });
});
