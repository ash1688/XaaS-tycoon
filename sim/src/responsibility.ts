// Who manages each layer under each deployment model (the shared responsibility model).
// This is the teaching content itself, not a balance number, so it lives here rather than in config.
import type { ModelId } from "./config.ts";

export type Owner = "you" | "provider" | "shared";

export const LAYER_IDS = ["facilities", "hardware", "os", "runtime", "application", "data"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

/** Layers from the bottom of the stack (the building) to the top (your data). */
export const LAYER_NAMES: Record<LayerId, string> = {
  facilities: "Building, power, cooling",
  hardware: "Hardware",
  os: "OS and patching",
  runtime: "Runtime and scaling",
  application: "Application / features",
  data: "Data and users",
};

const OWNERS: Record<ModelId, Record<LayerId, Owner>> = {
  onprem: { facilities: "you", hardware: "you", os: "you", runtime: "you", application: "you", data: "you" },
  iaas: { facilities: "provider", hardware: "provider", os: "you", runtime: "you", application: "you", data: "you" },
  paas: {
    facilities: "provider",
    hardware: "provider",
    os: "provider",
    runtime: "provider",
    application: "you",
    data: "you",
  },
  saas: {
    facilities: "provider",
    hardware: "provider",
    os: "provider",
    runtime: "provider",
    application: "shared",
    data: "you",
  },
};

export interface StackLayer {
  id: LayerId;
  name: string;
  owner: Owner;
}

/** The responsibility stack for a model, bottom layer first. */
export function responsibilityStack(model: ModelId): StackLayer[] {
  return LAYER_IDS.map((id) => ({ id, name: LAYER_NAMES[id], owner: OWNERS[model][id] }));
}
