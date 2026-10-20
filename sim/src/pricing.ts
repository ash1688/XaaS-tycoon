import type { GameConfig, ProductTypeId } from "./config.ts";
import { count, pounds } from "./finance.ts";
import { SimError, type GameState, type LogEntry } from "./state.ts";

/**
 * Pricing and revenue: the monthly price, the income it brings from paying users, and how it compares with the
 * product's fair price, which sets how fast users grow and how many new users pay.
 */
export function createPricing(config: GameConfig) {
  const fairPrice = (productType: ProductTypeId) => config.productTypes[productType].pricing.fairPrice;

  /** A new company's price and paid users: the fair price, and the product's starting free share. */
  function startingPricing(productType: ProductTypeId, users: number) {
    const { fairPrice, freeShare } = config.productTypes[productType].pricing;
    return { price: fairPrice, paidUsers: Math.round(users * (1 - freeShare)), income: 0 };
  }

  /** Sets the monthly price, to the penny. Paying users pay it from the next day played. */
  function setPrice(state: GameState, price: number): GameState {
    const { maxPrice } = config.pricing;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new SimError("bad_price", "Set a price above £0.");
    }
    if (price > maxPrice) throw new SimError("price_too_high", `The highest price you can set is ${pounds(maxPrice)} a month.`);
    return { ...state, price: Math.round(price * 100) / 100 };
  }

  /** The price against the fair price: 1 at the fair price, 2 at double it. */
  const priceRatio = (state: GameState) => state.price / fairPrice(state.productType);

  /** The day's growth is multiplied by this: below 1 above the fair price, above 1 (up to the cap) below it. */
  function priceGrowth(state: GameState): number {
    const { growthSensitivity, maxGrowthBoost } = config.pricing;
    return Math.min(maxGrowthBoost, priceRatio(state) ** -growthSensitivity);
  }

  /** Share of the day's new users who pay. The product's paid share at the fair price, less the dearer it is. */
  function paidShareOfNew(state: GameState): number {
    const { freeShare } = config.productTypes[state.productType].pricing;
    return Math.min(1, (1 - freeShare) * priceRatio(state) ** -config.pricing.paidShareSensitivity);
  }

  /**
   * Paid users once the day's users are known. New users split between paid and free by paidShareOfNew; if users
   * fell, paid and free fall in step.
   */
  function paidUsersAfter(state: GameState, users: number): number {
    const change = users - state.users;
    if (change >= 0) return state.paidUsers + Math.round(change * paidShareOfNew(state));
    return state.users === 0 ? 0 : Math.round((state.paidUsers * users) / state.users);
  }

  /** A day's income: paid users × price ÷ daysPerMonth, rounded to the pound, the same rule as monthly costs. */
  const dailyIncome = (state: GameState) => Math.round((state.paidUsers * state.price) / config.billing.daysPerMonth);

  /** The day's income, from the paying users at the start of the day. None when nobody pays. */
  function incomeEntries(state: GameState): LogEntry[] {
    const income = dailyIncome(state);
    if (income <= 0) return [];
    const text = `Income: ${count.format(state.paidUsers)} paying users at ${pounds(state.price)} a month`;
    return [{ text, cashDelta: income, kind: "income" }];
  }

  return { fairPrice, startingPricing, setPrice, priceGrowth, paidUsersAfter, dailyIncome, incomeEntries };
}

export type Pricing = ReturnType<typeof createPricing>;
