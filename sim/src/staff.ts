import { STAFF_POOLS, type GameConfig, type StaffPool } from "./config.ts";
import { isStaffPool, SimError, type GameState, type LogEntry } from "./state.ts";

/** Staff: hiring, letting go and moving people between developers, ops and support, and their pay. */
export function createStaff(config: GameConfig) {
  function changeStaff(state: GameState, type: "hire" | "letGo", pool: StaffPool): GameState {
    if (!isStaffPool(pool)) throw new SimError("unknown_pool", "Pick developers, ops or support.");
    if (type === "hire") return { ...state, [pool]: state[pool] + 1 };
    if (state[pool] < 1) {
      throw new SimError("no_staff", `You have no ${config.staff[pool].name.toLowerCase()} to let go.`);
    }
    return { ...state, [pool]: state[pool] - 1 };
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
