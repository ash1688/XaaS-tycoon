import type { GameConfig, HolidayConfig, HolidayEffect, HolidayStart } from "./config.ts";
import { nextRandom, seedRng } from "./rng.ts";
import type { GameState, LogEntry } from "./state.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A real date in a game: the date of one of its days. */
export interface GameDate {
  /** "2026-11-27". */
  iso: string;
  year: number;
  /** 1–12. */
  month: number;
  /** Day of the month, 1–31. */
  dayOfMonth: number;
  /** "Friday". */
  weekday: string;
  /** "Friday 27 November 2026". */
  text: string;
}

/** A holiday's dates in one year, and what it does to the company's product. */
export interface HolidayView {
  id: string;
  name: string;
  description: string;
  /** Its first and last dates, and the game days they fall on. */
  start: GameDate;
  end: GameDate;
  startDay: number;
  endDay: number;
  days: number;
  /** Days from the day just played to its start: 1 if it starts tomorrow, 0 or less once it has started. */
  daysUntil: number;
  /** What it does to this company's product, or null when the product doesn't notice it. */
  effect: HolidayEffect | null;
}

/** The calendar for the screen: today's date, the holidays on now and the next ones coming. */
export interface CalendarView {
  /** The date of the day just played. */
  today: GameDate;
  /** The year the game started in, and how many years in it is now. */
  startYear: number;
  /** Holidays on during the day just played. */
  on: HolidayView[];
  /** The next holidays to start, soonest first, up to the game's last day: one of each at most. */
  upcoming: HolidayView[];
}

/** Midnight UTC on a date, in ms: the calendar works in UTC so a date never shifts with the time zone. */
const utc = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day);

function toGameDate(ms: number): GameDate {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const dayOfMonth = d.getUTCDate();
  const weekday = WEEKDAYS[d.getUTCDay()]!;
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
  return { iso, year, month, dayOfMonth, weekday, text: `${weekday} ${dayOfMonth} ${MONTHS[month - 1]} ${year}` };
}

/** Ms for an ISO date "YYYY-MM-DD", or NaN if it isn't one. */
function parseIso(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return NaN;
  const ms = utc(Number(m[1]), Number(m[2]), Number(m[3]));
  return toGameDate(ms).iso === iso ? ms : NaN;
}

/** Whether a string is a real date, "YYYY-MM-DD". */
export const isIsoDate = (iso: string) => !Number.isNaN(parseIso(iso));

/** The date of a game day: day 1 is the start date. */
export function gameDate(state: Pick<GameState, "startDate">, day: number): GameDate {
  return toGameDate(parseIso(state.startDate) + (day - 1) * DAY_MS);
}

/** The game day a date falls on: 1 for the start date, 0 or less before it. */
export function dayOfDate(state: Pick<GameState, "startDate">, iso: string): number {
  return Math.round((parseIso(iso) - parseIso(state.startDate)) / DAY_MS) + 1;
}

/** Easter Sunday in a year, by the anonymous Gregorian algorithm. */
function easterSunday(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/** Black Friday in a year: the day after the fourth Thursday in November. */
function blackFriday(year: number): number {
  const first = new Date(utc(year, 11, 1)).getUTCDay();
  const firstThursday = 1 + ((4 - first + 7) % 7);
  return utc(year, 11, firstThursday + 21 + 1);
}

/** When a holiday starts in a year. */
function startIn(start: HolidayStart, year: number): number {
  if (start.anchor === "date") return utc(year, start.month, start.day);
  const anchor = start.anchor === "easter" ? easterSunday(year) : blackFriday(year);
  return anchor + start.offset * DAY_MS;
}

/** The game days a holiday runs in the year it starts. */
function occurrence(state: Pick<GameState, "startDate">, holiday: HolidayConfig, year: number) {
  const startDay = dayOfDate(state, toGameDate(startIn(holiday.start, year)).iso);
  return { startDay, endDay: startDay + holiday.days - 1 };
}

/**
 * The real calendar: each game starts on a random date and counts real dates forward from it. Holidays fall on their
 * dates every year as calendar events, outside the encounter system, and hit each product their own way: load and
 * demand, and growth, are multiplied by theirs on each of their days.
 */
export function createCalendar(config: GameConfig) {
  const { holidays } = config.calendar;

  /**
   * Day 1's date: a random day of the year, from a stream of its own seeded by the game's seed so the game's other
   * draws don't shift. In the given year, or the config's.
   */
  function startDate(seed: number, year = config.calendar.startYear): string {
    const first = utc(year, 1, 1);
    const days = Math.round((utc(year + 1, 1, 1) - first) / DAY_MS);
    const [r] = nextRandom(seedRng(seed ^ 0xca1e));
    return toGameDate(first + Math.floor(r * days) * DAY_MS).iso;
  }

  /** Each holiday's run that covers a game day: a holiday can start in the year before and run into the day's year. */
  function holidaysOn(state: Pick<GameState, "startDate">, day: number): HolidayConfig[] {
    const { year } = gameDate(state, day);
    return holidays.filter((h) =>
      [year - 1, year].some((y) => {
        const { startDay, endDay } = occurrence(state, h, y);
        return day >= startDay && day <= endDay;
      }),
    );
  }

  /** Each holiday on during a day with an effect on the product. */
  function effectsOn(state: Pick<GameState, "startDate" | "productType">, day: number): HolidayEffect[] {
    return holidaysOn(state, day).flatMap((h) => h.effects[state.productType] ?? []);
  }

  /** What the holidays on a day multiply the product's load and demand by: 1 on an ordinary day. */
  const loadMultiplier = (state: Pick<GameState, "startDate" | "productType">, day: number) =>
    effectsOn(state, day).reduce((m, e) => m * e.loadMultiplier, 1);

  /** What they multiply its growth by. */
  const growthMultiplier = (state: Pick<GameState, "startDate" | "productType">, day: number) =>
    effectsOn(state, day).reduce((m, e) => m * e.growthMultiplier, 1);

  function view(state: GameState, holiday: HolidayConfig, year: number): HolidayView {
    const { startDay, endDay } = occurrence(state, holiday, year);
    const { id, name, description, days } = holiday;
    return {
      id,
      name,
      description,
      start: gameDate(state, startDay),
      end: gameDate(state, endDay),
      startDay,
      endDay,
      days,
      daysUntil: startDay - state.day,
      effect: holiday.effects[state.productType] ?? null,
    };
  }

  /** The holidays on a product's calendar: every public holiday, and the industry events that hit it. */
  const shownTo = (state: Pick<GameState, "productType">) =>
    holidays.filter((h) => !h.industryEvent || !!h.effects[state.productType]);

  /** Each holiday's next run to start after a day, within the game, soonest first. */
  function nextAfter(state: GameState, day: number): HolidayView[] {
    const { year } = gameDate(state, day);
    return shownTo(state)
      .flatMap((h) => {
        const next = [year, year + 1].map((y) => view(state, h, y)).find((v) => v.startDay > day);
        return next && next.startDay <= (state.finalDay ?? Infinity) ? [next] : [];
      })
      .sort((a, b) => a.startDay - b.startDay);
  }

  function calendar(state: GameState): CalendarView {
    const { year } = gameDate(state, state.day);
    const on = shownTo(state).flatMap((h) =>
      [year - 1, year].map((y) => view(state, h, y)).filter((v) => state.day >= v.startDay && state.day <= v.endDay),
    );
    return { today: gameDate(state, state.day), startYear: gameDate(state, 1).year, on, upcoming: nextAfter(state, state.day) };
  }

  /** "load ×2.2, growth ×2.5". */
  const effectText = (e: HolidayEffect) => `load ×${e.loadMultiplier}, growth ×${e.growthMultiplier}`;

  /**
   * The log for a day: a holiday that hits the product is announced noticeDays before it starts, and logged on the day
   * it starts. One that doesn't hit it is left out of the log, though the calendar still shows it.
   */
  function dayEntries(state: GameState, day: number): LogEntry[] {
    const { year } = gameDate(state, day);
    const entries: LogEntry[] = [];
    for (const h of holidays) {
      const effect = h.effects[state.productType];
      if (!effect) continue;
      for (const y of [year - 1, year, year + 1]) {
        const v = view(state, h, y);
        if (v.startDay === day) {
          const text = `${h.name} starts today, for ${h.days} days: ${effect.detail} (${effectText(effect)})`;
          entries.push({ text, cashDelta: 0, kind: "calendar" });
        } else if (v.startDay - config.calendar.noticeDays === day) {
          const text = `${h.name} is coming in ${config.calendar.noticeDays} days, on ${v.start.text}: ${effect.detail} (${effectText(effect)}) Plan your capacity for it.`;
          entries.push({ text, cashDelta: 0, kind: "calendar" });
        }
      }
    }
    return entries;
  }

  return { startDate, holidaysOn, loadMultiplier, growthMultiplier, calendar, dayEntries };
}

export type Calendar = ReturnType<typeof createCalendar>;
