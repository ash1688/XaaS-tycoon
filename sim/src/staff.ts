import { STAFF_POOLS, type GameConfig, type StaffPool } from "./config.ts";
import { isStaffPool, SimError, type GameState, type LogEntry } from "./state.ts";

/** Staff: hiring, letting go and moving people between developers, ops and support, and their pay. */
export function createStaff(config: GameConfig) {
  /** Hires or lets go `count` people at once, one by default. Letting go more than the pool has is refused. */
  function changeStaff(state: GameState, type: "hire" | "letGo", pool: StaffPool, count = 1): GameState {
    if (!isStaffPool(pool)) throw new SimError("unknown_pool", "Pick developers, ops or support.");
    if (!Number.isInteger(count) || count < 1) throw new SimError("bad_count", "Pick a whole number of people, at least 1.");
    if (type === "hire") return { ...state, [pool]: state[pool] + count };
    const name = config.staff[pool].name.toLowerCase();
    if (state[pool] < 1) throw new SimError("no_staff", `You have no ${name} to let go.`);
    if (state[pool] < count) throw new SimError("no_staff", `You only have ${state[pool]} ${name} to let go.`);
    return { ...state, [pool]: state[pool] - count };
  }

  function moveStaff(state: GameState, to: StaffPool, from: StaffPool = to === "developers" ? "ops" : "developers"): GameState {
    if (!isStaffPool(to) || !isStaffPool(from)) throw new SimError("unknown_pool", "Pick developers, ops or support.");
    if (from === to) throw new SimError("same_pool", "Pick two different teams to move someone between.");
    if (state[from] < 1) {
      throw new SimError("no_staff", `You have no ${config.staff[from].name.toLowerCase()} to move.`);
    }
    return { ...state, [from]: state[from] - 1, [to]: state[to] + 1 };
  }

  function staffEntries(state: GameState): LogEntry[] {
    return STAFF_POOLS.filter((pool) => state[pool] > 0).map((pool) => {
      const { name, dayRate } = config.staff[pool];
      return { text: `${name} pay (${state[pool]})`, cashDelta: -state[pool] * dayRate, category: "staff" };
    });
  }

  function dailyStaffCost(state: GameState): number {
    return STAFF_POOLS.reduce((sum, pool) => sum + state[pool] * config.staff[pool].dayRate, 0);
  }

  return { changeStaff, moveStaff, staffEntries, dailyStaffCost };
}
