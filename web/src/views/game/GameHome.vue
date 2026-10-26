<script setup lang="ts">
import { computed } from "vue";
import type { GameDate, HolidayView } from "@xaas/sim";
import { formatCash, formatCount, formatPrice, formatUptime } from "../../api";
import { dayOf, days, devDays, useGame } from "../../game";
import { formatShare } from "../../shares";
import OverviewCard from "../../components/OverviewCard.vue";
import SummaryPanel from "../../components/SummaryPanel.vue";
import CapacityPanel from "../../panels/CapacityPanel.vue";
import DayLog from "../../panels/DayLog.vue";
import EventCards from "../../panels/EventCards.vue";
import FeaturesPanel from "../../panels/FeaturesPanel.vue";
import LaunchButton from "../../components/LaunchButton.vue";
import MigrationPanel from "../../panels/MigrationPanel.vue";
import PriceWavePanel from "../../panels/PriceWavePanel.vue";
import SpendPanel from "../../panels/SpendPanel.vue";
import StaffPanel from "../../panels/StaffPanel.vue";
import SupportPanel from "../../panels/SupportPanel.vue";

// Home: the company at a glance, the day log first, as what the last day did is the first thing to read. Each card
// opens a modal with the detail and its controls. Once the game has ended, its banner and summary come first, and the
// cards stay as a read-only record.
const game = useGame();
const page = (path: string) => `${game.base}/${path}`;

const lastDayTotal = computed(() => game.lastDay?.entries.reduce((sum, e) => sum + e.cashDelta, 0) ?? 0);
const userChange = computed(() =>
  game.company && game.previousUsers !== undefined ? game.company.users - game.previousUsers : undefined,
);
const signed = (n: number) => `${n < 0 ? "−" : "+"}${formatCount(Math.abs(n))}`;
const activeFeatures = computed(
  () => game.company?.features.filter((f) => f.status === "built" || f.status === "addon").length ?? 0,
);
const phaseName = (id: string) => game.meta?.migrationPhases.find((p) => p.id === id)?.name ?? id;
// The danger meter: shown as how far it has risen towards the top of its scale, never the hidden thresholds.
const danger = computed(() => game.company?.danger);
// The real calendar: today's date, any holiday on now and the ones coming, with what each does to the product.
const calendar = computed(() => game.company?.calendar);
const monthName = (d: GameDate) => d.text.split(" ")[2];
const shortDate = (d: GameDate) => `${d.dayOfMonth} ${monthName(d)}`;
const holidayEffect = (h: HolidayView) =>
  h.effect ? `load ×${h.effect.loadMultiplier}, sign-ups ×${h.effect.growthMultiplier}` : "no effect on you";
// Earlier days played this session, newest first, under the latest one in the full log.
const earlierDays = computed(() => game.dayLogs.slice(0, -1).toReversed());

// The launch: the MVP being built, ready to launch until the student presses Launch, users trickling in over the ramp
// from go-live, and for a week after it, the day it happened. Before go-live, a checklist of what to set up.
const launch = computed(() => game.company?.launch);
const launchOver = computed(() => (launch.value?.day ?? 0) + (launch.value?.rampDays ?? 1) - 1);
const showLaunch = computed(() => {
  const l = launch.value;
  const c = game.company;
  return !!l && !!c && !game.over && (l.status !== "launched" || c.day <= launchOver.value + 7);
});
const beforeUsers = computed(() => ["waiting", "upcoming", "ready"].includes(launch.value?.status ?? ""));
const launchHeadline = computed(() => {
  const l = launch.value;
  const c = game.company;
  if (!l || !c) return "";
  if (l.status === "launched") return `Launched on day ${l.day}`;
  if (l.status === "launching" && l.rampDay === 0) return `Going live on day ${l.day}`;
  if (l.status === "launching") return `Launching: users arriving (day ${l.rampDay} of ${l.rampDays})`;
  if (l.status === "ready") return "Ready to launch";
  // A done MVP that is waiting or upcoming launches by itself (a test or demo config): only the servers decide.
  if (c.mvp.done) return l.status === "waiting" ? "Waiting for capacity" : "Launching once your servers are ready";
  if (l.status === "waiting") return "Nobody is building your MVP";
  return `MVP done in ${days(c.mvp.daysLeft ?? 0)}`;
});
const launchText = computed(() => {
  const l = launch.value;
  const c = game.company;
  if (!l || !c) return "";
  // Only the users who have joined are shown: how many are still to come stays a surprise.
  const ramp = l.rampDays > 1 ? `, more each day for ${days(l.rampDays)}` : "";
  if (l.status === "launched") {
    return `Your first ${formatCount(l.arrived)} users joined from day ${l.day} to day ${launchOver.value}. They grow from here.`;
  }
  if (l.status === "launching" && l.rampDay === 0) {
    return `Your first users arrive at the end of day ${l.day}${ramp}. Hosting bills start that day.`;
  }
  if (l.status === "launching") {
    return `${formatCount(l.arrived)} users have joined so far, more on the way. Then normal growth takes over.`;
  }
  if (l.status === "ready") {
    return `Your MVP is done. Press Launch when you're set up: your first users arrive at the end of the next day${ramp}. Servers you rent cost nothing until then, but your staff are still paid every day you wait.`;
  }
  if (c.mvp.done) {
    return l.status === "waiting"
      ? `Nothing is set up to serve users yet. Your first users start arriving when your servers are ready${ramp}. Until then there's no income, but your staff are still paid.`
      : `Your first users start arriving at the end of the day your servers are ready${ramp}.`;
  }
  const delivery = game.buysServers ? ` Bought kit takes ${days(c.serverOptions[0]?.readyDays ?? 0)} to arrive, so order it while the MVP is built.` : "";
  if (l.status === "waiting") {
    return `Nobody is building your MVP. Once it's done you can press Launch, and your first users start arriving${ramp}. Until then there's no income, but your staff are still paid.${delivery}`;
  }
  return `Your MVP is done by the end of day ${c.mvp.launchDay}. Then you can press Launch, and your first users start arriving${ramp}. Until then there's no income, but your staff are still paid.${delivery}`;
});
// What to do before launch, each with the page that does it.
const launchSteps = computed(() => {
  const c = game.company;
  const l = c?.launch;
  if (!c || !l) return [];
  const steps: { id: string; text: string; done: boolean; page?: string; pageName?: string }[] = [];
  // A config can make the MVP no size: then there's nothing to build.
  if (c.mvp.total > 0)
    steps.push({
      id: "mvp",
      text: c.mvp.done
        ? "Build your MVP"
        : `Build your MVP: ${formatCount(c.mvp.progress)} of ${devDays(c.mvp.total)} done`,
      done: c.mvp.done,
      page: "product?tab=features",
      pageName: "Product",
    });
  if (!l.needsServers) steps.push({ id: "servers", text: "Nothing to set up: the provider runs the servers", done: true });
  else
    steps.push({
      id: "servers",
      text: game.managed
        ? "Set up app instances and a managed database"
        : `${game.buysServers ? "Buy" : "Rent"} your first servers: at least one app server and one database${c.mvp.done ? "" : ", ready by the time your MVP is done"} (a cache is optional; rented servers cost nothing until you launch)`,
      done: l.setUp,
      page: "infrastructure",
      pageName: "Infrastructure",
    });
  if (l.opsNeeded > 0)
    steps.push({
      id: "ops",
      text: `Hire ops: ${l.opsNeeded} needed to run ${l.needsServers ? "your servers" : "the service"}`,
      done: c.ops >= l.opsNeeded,
      page: "people",
      pageName: "People",
    });
  return steps;
});

// Anything that needs the student's attention, each with the page that deals with it.
const alerts = computed(() => {
  const c = game.company;
  if (!c || game.over) return [];
  const list: { id: string; text: string; detail: string; page: string; pageName: string }[] = [];
  // Running out of cash ends the game and capacity creeps up day by day, so they come first.
  if (game.lowCash && game.runway)
    list.push({
      id: "low-cash",
      text: game.runway.days ? `Cash runs out in about ${days(game.runway.days)}` : "Cash runs out tomorrow",
      detail: `You're losing ${formatCash(-game.runway.dailyNet)} a day. ${c.loanQuote ? "Take a bank loan or cut costs" : "Cut costs"} before you go below £0: ${c.rescue ? "there's no second rescue, so it's liquidation." : "a vulture VC would rescue you, but take most of the company."}`,
      page: "finance",
      pageName: "Finance",
    });
  // A rescue changes who owns the company: shown until the vulture VC's shares are bought back.
  if (c.rescue && c.rescue.buyBackPrice !== null)
    list.push({
      id: "rescue",
      text: `A vulture VC owns ${Math.round(c.rescue.vultureShare * 100)}% of the company`,
      detail: `It rescued you on day ${c.rescue.day} with ${formatCash(c.rescue.amount)} and forced cost cuts. It sells its shares back for ${formatCash(c.rescue.buyBackPrice)}, and there's no second rescue: run out of cash again and it's liquidation.`,
      page: "finance",
      pageName: "Finance",
    });
  if (game.loadLevel !== "ok")
    list.push({
      id: "load",
      text: game.loadLevel === "over" ? "Over capacity" : "Close to capacity",
      detail: game.tightest
        ? `${game.tightest.name} (${game.tightest.unit}) is at ${game.tightest.percent}% of capacity. Over 100% is an outage: ${game.tierFix(game.tightest.id)}.`
        : `Load is ${game.loadPercent}% of capacity. Over 100% is an outage.`,
      page: "infrastructure",
      pageName: "Infrastructure",
    });
  for (const e of game.events)
    list.push({
      id: `event-${e.id}`,
      text: e.name,
      detail: e.outcome,
      page: "infrastructure",
      pageName: "Infrastructure",
    });
  if (game.understaffed)
    list.push({
      id: "understaffed",
      text: `Understaffed: ${game.opsShort} ops short`,
      detail: game.provider
        ? `${game.modelName(c.model)} needs ${c.opsNeeded} ops staff to keep the service running.`
        : `${game.modelName(c.model)} needs ${c.opsNeeded} ops staff. Until you have them, capacity is cut.`,
      page: "people",
      pageName: "People",
    });
  if (game.satisfactionLevel !== "ok")
    list.push({
      id: "satisfaction",
      text: `Customer satisfaction ${c.satisfaction}%`,
      detail: `${formatCount(c.backlog)} tickets are waiting. Growth is slower and users are leaving until support clears the backlog.`,
      page: "customers",
      pageName: "Customers",
    });
  else if (game.supportShort)
    list.push({
      id: "support",
      text: `Support: ${game.supportShort} short`,
      detail: `Your users raise about ${formatCount(c.usualTickets)} tickets a day: ${game.supportNeeded} support staff keep up. Fewer, and a backlog builds.`,
      page: "customers",
      pageName: "Customers",
    });
  if (c.priceWave?.direction === "rise")
    list.push({
      id: "price-wave",
      text: c.priceWave.day ? `Price backlash: day ${c.priceWave.day} of ${c.priceWave.length}` : "Price backlash starts tomorrow",
      detail: `Customers are reacting to your rise to ${formatPrice(c.priceWave.to)}: paying users leave or drop to free, and complaints add support tickets.`,
      page: "customers",
      pageName: "Customers",
    });
  if (game.units?.loadBalancer.uncovered)
    list.push({
      id: "load-balancer",
      text: "Load balancer needed",
      detail: `${game.units.loadBalancer.uncovered} of your ${game.units.loadBalancer.appServers} app servers get no traffic until a load balancer covers them.`,
      page: "infrastructure",
      pageName: "Infrastructure",
    });
  else if (game.lbShortSoon)
    list.push({
      id: "load-balancer-soon",
      text: "Load balancer needed soon",
      detail: `Once your new servers are ready, ${game.lbShortSoon} app server${game.lbShortSoon === 1 ? "" : "s"} will get no traffic: from ${game.meta?.loadBalancerFrom ?? 2} app servers up, each one needs a load balancer to cover it. ${game.addVerb === "buy" ? "Buy" : "Rent"} one now.`,
      page: "infrastructure",
      pageName: "Infrastructure",
    });
  if (game.opsShortSoon)
    list.push({
      id: "ops-soon",
      text: `Ops needed soon: ${game.opsShortSoon} short`,
      detail: `Every server needs a share of an ops person's time. Once the kit on order arrives you'll need ${c.opsNeededOnceReady} ops; you have ${c.ops}. Too few, and capacity is cut.`,
      page: "people",
      pageName: "People",
    });
  if (game.building && game.building.daysLeft === null && !game.onSaas)
    list.push({
      id: "no-developers",
      text: `${game.building.name} has stopped`,
      detail: "No developers are working on it. Hire some to carry on.",
      page: "people",
      pageName: "People",
    });
  if (game.onSaas && game.configTeamShort)
    list.push({
      id: "config-team",
      text: "Can't buy add-ons",
      detail: `Add-ons need ${game.configTeamNeeded} developers to configure them. Hire ${game.configTeamShort} more.`,
      page: "people",
      pageName: "People",
    });
  if (game.migration?.overrunDays)
    list.push({
      id: "overrun",
      text: "Migration overrun",
      detail: `Moving is taking ${days(game.migration.overrunDays)} longer than planned, billed by both providers.`,
      page: "infrastructure",
      pageName: "Infrastructure",
    });
  for (const g of game.openGaps)
    list.push({
      id: `gap-${g.id}`,
      text: `Feature gap: ${g.feature}`,
      detail: "No add-on offers it, so growth is slower until you migrate and build it yourself.",
      page: "infrastructure",
      pageName: "Infrastructure",
    });
  return list;
});
</script>

<template>
  <template v-if="game.company">
    <div v-if="game.liquidated" class="bankrupt" role="alert" data-testid="liquidation-screen">
      <span class="badge">Liquidation</span>
      <h2>Game over: you ran out of cash again</h2>
      <p>
        {{ game.company.name }} went below £0 on day {{ game.company.day }}, after the vulture VC's rescue on day
        {{ game.company.rescue?.day }}. There's no second rescue, so the company has gone into liquidation and the game
        has ended. You can't continue or change anything. Look at where your money went below, then
        <RouterLink :to="`/play/${game.code}`">start a new company</RouterLink> and try a different plan.
      </p>
    </div>
    <div v-else-if="game.floated && game.company.ipo.result" class="game-end ipo-end" role="status" data-testid="floated-screen">
      <span class="badge">Floated</span>
      <h2>{{ game.company.name }} floated on day {{ game.company.ipo.result.day }}</h2>
      <p>
        You rang the opening bell: the IPO ends the game. {{ game.company.name }} closed its first day of trading worth
        <strong>{{ formatCash(game.company.ipo.result.marketValue) }}</strong>, and your
        {{ formatShare(game.company.ipo.result.studentShare) }} is worth
        <strong>{{ formatCash(game.company.ipo.result.studentValue) }}</strong>.
        <RouterLink :to="`${game.base}/ipo`">Watch the first day again</RouterLink>, look at how you did below, then
        <RouterLink :to="`/play/${game.code}`">start a new company</RouterLink>.
      </p>
    </div>
    <div v-else-if="game.finished && game.company.endedByTeacher" class="game-end" role="status" data-testid="ended-screen">
      <span class="badge">Ended</span>
      <h2>Your teacher ended the game on day {{ game.company.day }}</h2>
      <p>
        {{ game.company.name }} is scored as it stood on {{ dayOf(game.company.day, game.company.finalDay) }}. Look
        at how you did below, then <RouterLink :to="`/play/${game.code}`">go back to your companies</RouterLink>.
      </p>
    </div>
    <div v-else-if="game.finished" class="game-end" role="status" data-testid="finished-screen">
      <span class="badge">Finished</span>
      <h2>You made it to day {{ game.company.finalDay }}</h2>
      <p>
        {{ game.company.name }} kept going for the whole game. Look at how you did below: where your money went, and
        the days when spending jumped. Then <RouterLink :to="`/play/${game.code}`">start a new company</RouterLink> and
        try a different plan.
      </p>
    </div>
    <div v-else-if="game.retired" class="game-end retired" role="status" data-testid="retired-screen">
      <span class="badge">Retired</span>
      <h2>You retired {{ game.company.name }} on day {{ game.company.day }}</h2>
      <p>
        This game is in your history now, so you can't continue it. Look at how it went below, then
        <RouterLink :to="`/play/${game.code}`">go back to your companies</RouterLink>.
      </p>
    </div>

    <SummaryPanel
      v-if="game.over && game.summary"
      :summary="game.summary"
      :model-name="game.modelName(game.summary.model)"
      :retired="game.retired"
    />

    <EventCards v-if="!game.over" />

    <h2 v-if="game.over" class="overview-heading">Where it ended</h2>
    <h2 v-else class="visually-hidden">Overview</h2>
    <div class="overview-grid">
      <OverviewCard title="Day log" full>
        <div data-testid="home-day-log">
          <DayLog v-if="game.lastDay" :log="game.lastDay" brief />
          <p v-else class="muted">Press Continue to play day {{ game.company.day }}. What each day costs shows here.</p>
        </div>
        <template #detail>
          <template v-if="game.lastDay">
            <DayLog :log="game.lastDay" data-testid="day-log" />
            <template v-if="earlierDays.length">
              <h3 class="earlier-heading">Earlier days</h3>
              <details v-for="log in earlierDays" :key="log.day" class="earlier-day">
                <summary>Day {{ log.day }}</summary>
                <DayLog :log="log" />
              </details>
            </template>
            <p class="muted">The log covers the days played since you opened this game.</p>
          </template>
          <p v-else>No days played since you opened this game. Press Continue to play day {{ game.company.day }}.</p>
        </template>
      </OverviewCard>

      <OverviewCard
        v-if="showLaunch && launch"
        title="Launch"
        full
        :tone="launch.status === 'waiting' || launch.status === 'ready' ? 'warn' : launch.status === 'launched' || launch.status === 'launching' ? 'ok' : undefined"
      >
        <div data-testid="launch-card" :data-status="launch.status">
          <p class="overview-value" data-testid="launch-headline">{{ launchHeadline }}</p>
          <p class="muted" data-testid="launch-text">{{ launchText }}</p>
          <ul v-if="beforeUsers" class="launch-checklist" data-testid="launch-checklist">
            <li v-for="step in launchSteps" :key="step.id" :class="{ done: step.done }" :data-testid="`launch-step-${step.id}`">
              <span class="launch-check" aria-hidden="true">{{ step.done ? "✓" : "○" }}</span>
              <span>
                {{ step.text }}<span class="visually-hidden">{{ step.done ? " (done)" : " (to do)" }}</span>
                <template v-if="step.page && !step.done">
                  · <RouterLink :to="page(step.page)">{{ step.pageName }}</RouterLink>
                </template>
              </span>
            </li>
          </ul>
          <LaunchButton />
        </div>
        <template #detail>
          <p>{{ launchText }}</p>
          <ul v-if="beforeUsers" class="launch-checklist">
            <li v-for="step in launchSteps" :key="step.id" :class="{ done: step.done }">
              <span class="launch-check" aria-hidden="true">{{ step.done ? "✓" : "○" }}</span>
              <span>
                {{ step.text }}<span class="visually-hidden">{{ step.done ? " (done)" : " (to do)" }}</span>
                <template v-if="step.page">
                  · <RouterLink :to="page(step.page)">Open {{ step.pageName }}</RouterLink>
                </template>
              </span>
            </li>
          </ul>
          <LaunchButton />
          <p>
            Once your MVP is done, the company waits, ready to launch, until you press Launch. Go-live is the next day
            played: your first users arrive at the end of it, so have servers ready to serve them by then (rented VMs
            are ready the day after you rent them, a platform's instances at once, and bought kit when it arrives). You
            can launch without an app server, a database or ops, but users you can't serve leave. They trickle in over
            {{ days(launch.rampDays) }}, more each day, and you won't know how many until they've all joined; then
            normal growth takes over. Until go-live there are no users, no income, no tickets and no hosting bills, but
            staff and any loan repayments are still charged.
          </p>
        </template>
      </OverviewCard>

      <OverviewCard title="Cash" :tone="game.company.cash < 0 || game.lowCash ? 'warn' : undefined">
        <p :class="['overview-value', { neg: game.company.cash < 0 }]" data-testid="cash">
          {{ formatCash(game.company.cash) }}
        </p>
        <p class="muted">
          <template v-if="game.lastDay">
            <strong :class="lastDayTotal < 0 ? 'neg' : 'pos'">{{ formatCash(lastDayTotal) }}</strong> on day
            {{ game.lastDay.day }}.
          </template>
          Infrastructure {{ formatCash(game.company.monthlyInfrastructureCost) }} a month, staff
          {{ formatCash(game.company.dailyStaffCost) }} a day.
        </p>
        <p v-if="!game.over" :class="['runway', { 'warn-text': game.lowCash }]" data-testid="home-runway">
          <template v-if="game.company.runway.days === null">
            Not losing money: <strong class="pos">+{{ formatCash(game.company.runway.dailyNet) }}</strong> a day.
          </template>
          <template v-else>
            Runway <strong>{{ game.company.runway.days ? days(game.company.runway.days) : "under a day" }}</strong>: losing
            {{ formatCash(-game.company.runway.dailyNet) }} a day.
          </template>
        </p>
        <p class="muted" data-testid="home-loan">
          <template v-if="game.company.loan?.remaining">
            Includes a {{ formatCash(game.company.loan.amount) }} bank loan:
            <strong>{{ formatCash(game.company.loan.dailyRepayment) }}</strong> a day to repay until day
            {{ game.company.loan.lastDay }}, {{ formatCash(game.company.loan.remaining) }} left.
          </template>
          <template v-else-if="game.company.loan">Bank loan repaid in full.</template>
          <template v-else-if="game.liquidated">No bank loan: banks don't lend to a company in liquidation.</template>
          <template v-else-if="game.company.loanQuote && !game.over">
            No bank loan. You can borrow {{ formatCash(game.company.loanQuote.amount) }} on Finance.
          </template>
          <template v-else>No bank loan.</template>
        </p>
        <template #detail>
          <p v-if="!game.over" data-testid="runway-detail">
            A usual day brings in {{ formatCash(game.company.runway.dailyIncome) }} and costs
            {{ formatCash(game.company.runway.dailyCosts) }}<template v-if="game.company.runway.days === null">, so
              cash is growing.</template
            ><template v-else>: at that rate your {{ formatCash(game.company.cash) }} lasts about
              {{ days(game.company.runway.days) }}. {{ game.company.rescue ? "Below £0 again is liquidation." : "Below £0 brings a vulture VC's rescue, for most of the company." }}</template
            >
          </p>
          <SpendPanel />
          <p class="modal-link"><RouterLink :to="page('finance')">Open Finance</RouterLink></p>
        </template>
      </OverviewCard>

      <OverviewCard title="Income">
        <p class="overview-value pos" data-testid="home-income">
          {{ formatCash(game.company.dailyIncome) }} <small>a day</small>
        </p>
        <p class="muted" data-testid="home-paid-free">
          {{ formatCount(game.company.paidUsers) }} paying, {{ formatCount(game.company.freeUsers) }} free, at
          {{ formatPrice(game.company.price) }} a month. {{ formatCash(game.company.income) }} so far.
        </p>
        <p class="muted" data-testid="home-conversions">
          <strong class="pos">{{ formatCount(game.company.conversion.today) }}</strong> free
          {{ game.company.conversion.today === 1 ? "user" : "users" }} started paying<template v-if="game.lastDay">
            on day {{ game.lastDay.day }}</template
          >.
        </p>
        <template #detail>
          <div class="stats">
            <div class="stat">
              <span class="label">Income a day</span>
              <span class="value pos">{{ formatCash(game.company.dailyIncome) }}</span>
              <small>{{ formatCash(game.company.income) }} so far</small>
            </div>
            <div class="stat">
              <span class="label">Paying</span>
              <span class="value">{{ formatCount(game.company.paidUsers) }}</span>
            </div>
            <div class="stat">
              <span class="label">Free</span>
              <span class="value">{{ formatCount(game.company.freeUsers) }}</span>
            </div>
            <div class="stat">
              <span class="label">Started paying</span>
              <span class="value pos">{{ formatCount(game.company.conversion.today) }}</span>
              <small>{{ (100 * game.company.conversion.rate).toFixed(2) }}% of free users a day</small>
            </div>
            <div class="stat">
              <span class="label">Monthly price</span>
              <span class="value">{{ formatPrice(game.company.price) }}</span>
              <small>Fair price {{ formatPrice(game.company.fairPrice) }}</small>
            </div>
          </div>
          <p>
            Each paying user pays a day's share of your monthly price. Free users pay nothing but still cost you load
            and, on SaaS, per-user fees. Pricing above the fair price slows growth and means fewer new users pay.
            A few free users start paying each day: more with features, good uptime and happy customers, fewer at a
            high price. See what's helping or hurting on Customers.
          </p>
          <p class="modal-link">
            <RouterLink :to="page('product?tab=price')">Change the price on Product</RouterLink> ·
            <RouterLink :to="page('customers')">Open Customers</RouterLink> ·
            <RouterLink :to="page('finance')">Open Finance</RouterLink>
          </p>
        </template>
      </OverviewCard>

      <OverviewCard
        v-if="game.company.priceWave && !game.over"
        :title="game.company.priceWave.direction === 'rise' ? 'Price backlash' : 'Price cut wave'"
        :tone="game.company.priceWave.direction === 'rise' ? 'warn' : 'ok'"
      >
        <p class="overview-value" data-testid="home-wave">
          <template v-if="game.company.priceWave.day">
            Day {{ game.company.priceWave.day }} <small>of {{ game.company.priceWave.length }}</small>
          </template>
          <template v-else>Starts tomorrow</template>
        </p>
        <div class="meter" aria-hidden="true">
          <div
            :class="['meter-fill', game.company.priceWave.direction === 'rise' ? 'over' : 'ok']"
            :style="{ width: `${(100 * game.company.priceWave.day) / game.company.priceWave.length}%` }"
          ></div>
        </div>
        <p class="muted">
          <template v-if="game.company.priceWave.direction === 'rise'">
            {{ formatCount(game.company.priceWave.done.left) }} paying users left,
            {{ formatCount(game.company.priceWave.done.toFree) }} dropped to free so far.
          </template>
          <template v-else>
            {{ formatCount(game.company.priceWave.done.joined) }} joined,
            {{ formatCount(game.company.priceWave.done.upgraded) }} upgraded so far.
          </template>
          Price locked for {{ days(game.company.priceLockDaysLeft) }}.
        </p>
        <template #detail>
          <PriceWavePanel />
          <p class="modal-link">
            <RouterLink :to="page('product?tab=price')">Open Product</RouterLink> ·
            <RouterLink :to="page('customers')">Open Customers</RouterLink>
          </p>
        </template>
      </OverviewCard>

      <OverviewCard title="Users">
        <p class="overview-value" data-testid="users">{{ formatCount(game.company.users) }}</p>
        <p class="muted">
          <template v-if="userChange !== undefined">
            <strong :class="userChange < 0 ? 'neg' : 'pos'">{{ signed(userChange) }}</strong> on day
            {{ game.lastDay?.day }}.
          </template>
          {{ activeFeatures }} of {{ game.company.features.length }} features live.
        </p>
        <template #detail>
          <div class="stats">
            <div class="stat">
              <span class="label">Users</span>
              <span class="value">{{ formatCount(game.company.users) }}</span>
              <small v-if="userChange !== undefined">{{ signed(userChange) }} on day {{ game.lastDay?.day }}</small>
            </div>
            <div class="stat">
              <span class="label">Features live</span>
              <span class="value">{{ activeFeatures }} <small>of {{ game.company.features.length }}</small></span>
            </div>
          </div>
          <p>
            Users grow every day. Each feature you build, or add-on you buy on SaaS, speeds that up; outages and
            feature gaps slow it down.
          </p>
          <FeaturesPanel />
          <p class="modal-link">
            <RouterLink :to="page('customers')">Open Customers</RouterLink> ·
            <RouterLink :to="page('product?tab=features')">Open Product</RouterLink>
          </p>
        </template>
      </OverviewCard>

      <OverviewCard
        v-if="game.tightest"
        title="Capacity"
        :tone="game.loadLevel === 'ok' && !game.units?.loadBalancer.uncovered && !game.lbShortSoon ? undefined : 'warn'"
      >
        <p class="overview-value" data-testid="home-tightest">
          {{ game.tightest.unit }}
          {{ game.tightest.capacity > 0 ? `${game.tightest.percent}%` : game.tightest.demand > 0 ? "full" : "none yet" }}
          <small>tightest</small>
          <span v-if="game.tightest.capacity > 0 && game.tightest.level !== 'ok'" class="badge warn-badge" data-testid="home-nearly-full">
            {{ game.tightest.level === "over" ? "Over" : "Nearly full" }}
          </span>
        </p>
        <div class="meter" aria-hidden="true">
          <div
            :class="['meter-fill', game.tightest.level]"
            :style="{ width: `${Math.min(100, game.tightest.percent)}%` }"
          ></div>
        </div>
        <p class="muted" data-testid="home-capacity">
          {{ game.tightest.name }} sets your capacity: {{ formatCount(game.tightest.demand) }} of
          {{ formatCount(game.tightest.capacity) }} {{ game.tightest.unit }}.
          <span v-if="game.tightest.capacity > 0 && game.tightest.level === 'high'" class="warn-text">
            Nearly full: {{ game.tierFix(game.tightest.id, "before it hits 100%") }}.
          </span>
          <span v-if="game.units?.loadBalancer.uncovered" class="warn-text">Load balancer needed.</span>
          <span v-else-if="game.lbShortSoon" class="warn-text">Load balancer needed once your new servers are ready.</span>
          <span v-if="game.onOrder.length" data-testid="home-on-order">
            {{ game.onOrder.length }} server{{ game.onOrder.length === 1 ? "" : "s" }} on order, the next arriving in
            {{ Math.min(...game.onOrder.map((s) => s.daysLeft)) }}
            day{{ Math.min(...game.onOrder.map((s) => s.daysLeft)) === 1 ? "" : "s" }}.
          </span>
          Uptime <strong data-testid="uptime">{{ formatUptime(game.company.uptime) }}</strong>.
        </p>
        <template #detail>
          <CapacityPanel />
          <p class="modal-link">
            <RouterLink :to="page('infrastructure')">
              {{ game.managed ? "Scale your platform" : game.buysServers ? "Buy servers" : "Rent servers" }} on Infrastructure
            </RouterLink>
          </p>
        </template>
      </OverviewCard>

      <OverviewCard v-else-if="game.provider" title="Capacity">
        <p class="overview-value" data-testid="home-provider">Unlimited <small>provider-managed</small></p>
        <p class="muted" data-testid="home-capacity">
          The provider scales for you: no servers, no limit. You pay
          {{ formatPrice(game.provider.perUserFee) }} a user a month instead,
          {{ formatCash(game.provider.monthlyPerUserBill) }} a month for your {{ formatCount(game.provider.users) }} users,
          free ones included. Uptime <strong data-testid="uptime">{{ formatUptime(game.company.uptime) }}</strong>.
        </p>
        <template #detail>
          <CapacityPanel />
          <p class="modal-link"><RouterLink :to="page('infrastructure')">Open Infrastructure</RouterLink></p>
        </template>
      </OverviewCard>

      <OverviewCard v-else title="Uptime and capacity" :tone="game.loadLevel === 'ok' ? undefined : 'warn'">
        <p class="overview-value" data-testid="uptime">{{ formatUptime(game.company.uptime) }}</p>
        <div class="meter" aria-hidden="true">
          <div :class="['meter-fill', game.loadLevel]" :style="{ width: `${Math.min(100, game.loadPercent)}%` }"></div>
        </div>
        <p class="muted" data-testid="home-capacity">
          Load {{ game.loadPercent }}% of capacity ({{ formatCount(game.company.load) }} /
          {{ formatCount(game.company.capacity ?? 0) }}).
          <template v-if="game.company.outageDays">
            {{ game.company.outageDays }} outage day{{ game.company.outageDays === 1 ? "" : "s" }}.
          </template>
        </p>
        <template #detail>
          <CapacityPanel />
          <p class="modal-link"><RouterLink :to="page('infrastructure')">Open Infrastructure</RouterLink></p>
        </template>
      </OverviewCard>

      <OverviewCard title="Satisfaction" :tone="game.satisfactionLevel === 'ok' ? undefined : 'warn'">
        <p class="overview-value" data-testid="home-satisfaction">{{ game.company.satisfaction }}%</p>
        <div class="meter" aria-hidden="true">
          <div :class="['meter-fill', game.satisfactionLevel]" :style="{ width: `${game.company.satisfaction}%` }"></div>
        </div>
        <p class="muted" data-testid="home-backlog">
          Backlog {{ formatCount(game.company.backlog) }} ticket{{ game.company.backlog === 1 ? "" : "s" }}.
          {{ game.company.support }} support staff clear up to {{ formatCount(game.company.dailyClearance) }} a day.
        </p>
        <template #detail>
          <SupportPanel />
          <p class="modal-link">
            <RouterLink :to="page('customers')">Open Customers</RouterLink> ·
            <RouterLink :to="page('people')">Open People</RouterLink>
          </p>
        </template>
      </OverviewCard>

      <OverviewCard
        v-if="!game.over && calendar"
        title="Calendar"
        :tone="calendar.on.some((h) => h.effect) ? 'warn' : undefined"
      >
        <p class="overview-value" data-testid="calendar-date">
          {{ calendar.today.dayOfMonth }} {{ monthName(calendar.today) }} <small>{{ calendar.today.year }}</small>
        </p>
        <p v-for="h in calendar.on" :key="h.id" data-testid="holiday-on">
          <strong>{{ h.name }}</strong> now, to {{ shortDate(h.end) }}: {{ holidayEffect(h) }}.
        </p>
        <p v-if="calendar.upcoming[0]" class="muted" data-testid="holiday-next">
          Next: {{ calendar.upcoming[0].name }} in {{ calendar.upcoming[0].daysUntil }}
          {{ calendar.upcoming[0].daysUntil === 1 ? "day" : "days" }} ({{ holidayEffect(calendar.upcoming[0]) }}).
        </p>
        <p v-else class="muted">No more holidays before the game ends.</p>
        <template #detail>
          <p>
            Your company runs on a real calendar, from {{ calendar.startYear }}. Holidays fall on their dates every year and hit each product its own way: more load and more sign-ups, or fewer. They don't touch
            the danger meter, so you can see them coming and plan your capacity.
          </p>
          <ul class="holiday-list" data-testid="holiday-list">
            <li v-for="h in [...calendar.on, ...calendar.upcoming]" :key="`${h.id}-${h.startDay}`" :data-holiday="h.id">
              <strong>{{ h.name }}</strong>
              <span class="when">
                {{ shortDate(h.start) }} to {{ shortDate(h.end) }}
                ({{ h.daysUntil > 0 ? `in ${h.daysUntil} ${h.daysUntil === 1 ? "day" : "days"}` : "on now" }})
              </span>
              <br />
              {{ h.description }}
              <template v-if="h.effect">{{ h.effect.detail }} ({{ holidayEffect(h) }})</template>
              <template v-else>Your product doesn't notice it.</template>
            </li>
          </ul>
        </template>
      </OverviewCard>

      <OverviewCard v-if="!game.over" title="Danger meter" :tone="danger?.risks.length || danger?.warning ? 'warn' : undefined">
        <div v-if="danger" data-testid="danger-card">
          <p class="overview-value" data-testid="danger-rise">
            +{{ danger.rise }} <small>on day {{ game.company.day }}</small>
          </p>
          <div class="meter" aria-hidden="true">
            <div
              :class="['meter-fill', danger.risks.length ? 'over' : 'ok']"
              :style="{ width: `${Math.min(100, (100 * danger.meter) / danger.max)}%` }"
            ></div>
          </div>
          <p class="muted" data-testid="danger-text">
            <template v-if="danger.risks.length">
              Climbing fast: {{ danger.risks.map((r) => r.label.toLowerCase()).join(", ") }}.
            </template>
            <template v-else-if="danger.rise">Creeping: a well-run day.</template>
            <template v-else>Still until launch: nothing can go wrong yet.</template>
          </p>
          <p v-if="danger.warning" class="warn-text" data-testid="danger-warning">
            <strong>Warning:</strong> {{ danger.warning.text }}
          </p>
        </div>
        <template #detail>
          <p>
            Trouble builds up. The danger meter rises every day after launch, and when it reaches a hidden threshold a
            random event happens: a traffic spike, an OS patch, a provider outage or price rise, or a feature your
            platform can't provide. Then it drops back to 0 and starts again. You won't know which event is next, or
            when, but how you run the company decides how fast it comes, and makes some events more likely. The one
            exception is a traffic spike: you get a tip-off about a week before, time to add capacity.
          </p>
          <p v-if="danger" data-testid="danger-detail">
            A well-run day adds {{ danger.dailyRise }}.<template v-if="danger.risks.length">
              On day {{ game.company.day }} it rose {{ danger.rise }}, because:</template
            >
          </p>
          <ul v-if="danger?.risks.length" class="danger-risks">
            <li v-for="r in danger.risks" :key="r.id" :data-risk="r.id">
              <strong>{{ r.label }} (+{{ r.rise }}).</strong> {{ r.detail }}
            </li>
          </ul>
        </template>
      </OverviewCard>

      <OverviewCard title="Staff" :tone="game.understaffed || game.opsShortSoon ? 'warn' : undefined">
        <p class="overview-value" data-testid="home-staff">
          {{ game.company.developers }} <small>dev</small> · {{ game.company.ops }} <small>ops</small> ·
          {{ game.company.support }} <small>support</small>
        </p>
        <p class="muted">
          {{ formatCash(game.company.dailyStaffCost) }} a day.
          <span v-if="game.understaffed" class="warn-text">
            {{ game.opsShort }} ops short.
          </span>
          <span v-else-if="game.opsShortSoon" class="warn-text">
            {{ game.opsShortSoon }} more ops needed once your kit arrives.
          </span>
        </p>
        <template #detail>
          <StaffPanel />
          <p class="modal-link"><RouterLink :to="page('people')">Open People</RouterLink></p>
        </template>
      </OverviewCard>

      <OverviewCard v-if="!game.over" title="Alerts" wide :tone="alerts.length ? 'warn' : 'ok'">
        <p class="overview-value">{{ alerts.length || "All clear" }}<small v-if="alerts.length"> to look at</small></p>
        <ul v-if="alerts.length" class="alert-list" data-testid="home-alerts">
          <li v-for="a in alerts.slice(0, 3)" :key="a.id">{{ a.text }}</li>
          <li v-if="alerts.length > 3" class="muted">and {{ alerts.length - 3 }} more</li>
        </ul>
        <p v-else class="muted" data-testid="home-alerts">Nothing needs you right now.</p>
        <template #detail>
          <ul v-if="alerts.length" class="alert-detail">
            <li v-for="a in alerts" :key="a.id">
              <strong>{{ a.text }}</strong>
              <span>{{ a.detail }}</span>
              <RouterLink :to="page(a.page)">Go to {{ a.pageName }}</RouterLink>
            </li>
          </ul>
          <p v-else>Nothing needs you right now. Keep an eye on load as your users grow.</p>
        </template>
      </OverviewCard>

      <OverviewCard title="Product">
        <p class="overview-value">
          {{ activeFeatures }} <small>of {{ game.company.features.length }} {{ game.onSaas ? "add-ons" : "built" }}</small>
        </p>
        <p class="muted" data-testid="home-product">
          <template v-if="game.building && !game.onSaas">
            Building {{ game.building.name }}: {{ game.building.progress }} of {{ devDays(game.building.devDays) }}.
          </template>
          <template v-else-if="game.onSaas">Add-ons {{ formatCash(game.company.monthlyAddonCost) }} a month.</template>
          <template v-else>Nothing being built.</template>
        </p>
        <template #detail>
          <FeaturesPanel />
          <p class="modal-link"><RouterLink :to="page('product?tab=features')">Open Product</RouterLink></p>
        </template>
      </OverviewCard>

      <OverviewCard title="Migration" :tone="game.migration?.overrunDays ? 'warn' : undefined">
        <template v-if="game.migration">
          <p class="overview-value overview-text">To {{ game.modelName(game.migration.to) }}</p>
          <p class="muted" data-testid="home-migration">
            {{ phaseName(game.migration.phase) }}: switch in {{ days(game.migration.daysLeft) }}.
          </p>
        </template>
        <template v-else>
          <p class="overview-value overview-text">{{ game.modelName(game.company.model) }}</p>
          <p class="muted" data-testid="home-migration">
            Not migrating. {{ game.company.migrations }} completed.
          </p>
        </template>
        <template #detail>
          <MigrationPanel />
          <p class="modal-link"><RouterLink :to="page('infrastructure')">Open Infrastructure</RouterLink></p>
        </template>
      </OverviewCard>
    </div>
  </template>
</template>
