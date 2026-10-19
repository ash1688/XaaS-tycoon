// All balance numbers live here. Figures are placeholders, to be tuned after the alpha.

export const MODEL_IDS = ["onprem", "iaas", "paas", "saas"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const PRODUCT_TYPE_IDS = ["ecommerce", "social", "video"] as const;
export type ProductTypeId = (typeof PRODUCT_TYPE_IDS)[number];

export interface ModelConfig {
  name: string;
  /** One-line description shown when choosing a model. */
  blurb: string;
  /** Placeholder running cost per day until the full ledger lands. */
  dailyCost: number;
}

export interface ProductTypeConfig {
  name: string;
  /** Short description of how this product behaves. */
  profile: string;
}

export interface GameConfig {
  startingCash: number;
  finalDay: number;
  maxCompanyNameLength: number;
  models: Record<ModelId, ModelConfig>;
  productTypes: Record<ProductTypeId, ProductTypeConfig>;
}

export const defaultConfig: GameConfig = {
  startingCash: 50_000,
  finalDay: 180,
  maxCompanyNameLength: 40,
  models: {
    onprem: { name: "Own servers (on-prem)", blurb: "Buy and run your own kit.", dailyCost: 150 },
    iaas: { name: "Rent VMs (IaaS)", blurb: "Rent virtual machines and run everything on them.", dailyCost: 200 },
    paas: { name: "Deploy to a platform (PaaS)", blurb: "Hand over your code; the platform runs it.", dailyCost: 250 },
    saas: {
      name: "Build on a SaaS platform (SaaS)",
      blurb: "Build inside someone else's SaaS platform, like a shop on Shopify.",
      dailyCost: 120,
    },
  },
  productTypes: {
    ecommerce: { name: "E-commerce platform", profile: "Big seasonal traffic spikes" },
    social: { name: "Social network", profile: "Steady viral growth" },
    video: { name: "Video sharing platform", profile: "Heavy storage and bandwidth costs" },
  },
};
