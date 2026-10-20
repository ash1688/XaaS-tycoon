<script setup lang="ts">
import { computed } from "vue";
import { formatCash, formatCount, formatPrice, formatUptime } from "../../api";
import { days, useGame } from "../../game";
import OverviewCard from "../../components/OverviewCard.vue";
import SummaryPanel from "../../components/SummaryPanel.vue";
import CapacityPanel from "../../panels/CapacityPanel.vue";
import DayLog from "../../panels/DayLog.vue";
import EventCards from "../../panels/EventCards.vue";
import FeaturesPanel from "../../panels/FeaturesPanel.vue";
import MigrationPanel from "../../panels/MigrationPanel.vue";
import PriceWavePanel from "../../panels/PriceWavePanel.vue";
import SpendPanel from "../../panels/SpendPanel.vue";
import StaffPanel from "../../panels/StaffPanel.vue";
import SupportPanel from "../../panels/SupportPanel.vue";

// Home: the company at a glance. Each card opens a modal with the detail and its controls. Once the game has ended,
// its banner and summary come first, and the cards stay as a read-only record.
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
// Earlier days played this session, newest first, under the latest one in the full log.
const earlierDays = computed(() => game.dayLogs.slice(0, -1).toReversed());

// Anything that needs the student's attention, each with the page that deals with it.
const alerts = computed(() => {
  const c = game.company;
  if (!c || game.over) return [];
  const list: { id: string; text: string; detail: string; page: string; pageName: string }[] = [];
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
      text: `Understaffed: ${c.opsNeeded - c.ops} ops short`,
      detail: `${game.modelName(c.model)} needs ${c.opsNeeded} ops staff. Until you have them, capacity is cut.`,
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
  if (game.loadLevel !== "ok")
    list.push({
      id: "load",
      text: game.loadLevel === "over" ? "Over capacity" : "Close to capacity",
      detail: game.tightest
        ? `${game.tightest.name} (${game.tightest.unit}) is at ${game.tightest.percent}% of capacity. Over 100% is an outage: ${game.addVerb} more ${game.tightest.servers}.`
        : `Load is ${game.loadPercent}% of capacity. Over 100% is an outage.`,
      page: "infrastructure",
      pageName: "Infrastructure",
    });
  if (game.units?.loadBalancer.uncovered)
    list.push({
      id: "load-balancer",
      text: "Load balancer needed",
      detail: `${game.units.loadBalancer.uncovered} of your ${game.units.loadBalancer.appServers} app servers get no traffic until a load balancer covers them.`,
      page: "infrastructure",
      pageName: "Infrastructure",
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
    <div v-if="game.bankrupt" class="bankrupt" role="alert" data-testid="bankrupt-screen">
      <span class="badge">Bankrupt</span>
      <h2>Game over: you ran out of cash</h2>
      <p>
        {{ game.company.name }} went below £0 on day {{ game.company.day }}, so the game has ended. You can't continue
        or change anything. Look at where your money went below, then
        <RouterLink :to="`/play/${game.code}`">start a new company</RouterLink> and try a different plan.
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
      <OverviewCard title="Cash" :tone="game.company.cash < 0 ? 'warn' : undefined">
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
        <template #detail>
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
            <RouterLink :to="page('product')">Change the price on Product</RouterLink> ·
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
            <RouterLink :to="page('product')">Open Product</RouterLink> ·
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
            <RouterLink :to="page('product')">Open Product</RouterLink>
          </p>
        </template>
      </OverviewCard>

      <OverviewCard
        v-if="game.tightest"
        title="Capacity"
        :tone="game.loadLevel === 'ok' && !game.units?.loadBalancer.uncovered ? undefined : 'warn'"
      >
        <p class="overview-value" data-testid="home-tightest">
          {{ game.tightest.unit }} {{ game.tightest.capacity > 0 ? `${game.tightest.percent}%` : "full" }}
          <small>tightest</small>
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
          <span v-if="game.units?.loadBalancer.uncovered" class="warn-text">Load balancer needed.</span>
          <span v-if="game.onOrder.length" data-testid="home-on-order">
            {{ game.onOrder.length }} server{{ game.onOrder.length === 1 ? "" : "s" }} on order, the next arriving in
            {{ Math.min(...game.onOrder.map((s) => s.daysLeft)) }}
            day{{ Math.min(...game.onOrder.map((s) => s.daysLeft)) === 1 ? "" : "s" }}.
          </span>
          Uptime <strong data-testid="uptime">{{ formatUptime(game.company.uptime) }}</strong>.
        </p>
        <template #detail>
          <CapacityPanel />
          <p class="modal-link"><RouterLink :to="page('infrastructure')">{{ game.buysServers ? "Buy" : "Rent" }} servers on Infrastructure</RouterLink></p>
        </template>
      </OverviewCard>

      <OverviewCard v-else title="Uptime and capacity" :tone="game.loadLevel === 'ok' ? undefined : 'warn'">
        <p class="overview-value" data-testid="uptime">{{ formatUptime(game.company.uptime) }}</p>
        <div class="meter" aria-hidden="true">
          <div :class="['meter-fill', game.loadLevel]" :style="{ width: `${Math.min(100, game.loadPercent)}%` }"></div>
        </div>
        <p class="muted" data-testid="home-capacity">
          Load {{ game.loadPercent }}% of capacity ({{ formatCount(game.company.load) }} /
          {{ formatCount(game.company.capacity) }}).
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

      <OverviewCard title="Staff" :tone="game.understaffed ? 'warn' : undefined">
        <p class="overview-value" data-testid="home-staff">
          {{ game.company.developers }} <small>dev</small> · {{ game.company.ops }} <small>ops</small> ·
          {{ game.company.support }} <small>support</small>
        </p>
        <p class="muted">
          {{ formatCash(game.company.dailyStaffCost) }} a day.
          <span v-if="game.understaffed" class="warn-text">
            {{ game.company.opsNeeded - game.company.ops }} ops short.
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
            Building {{ game.building.name }}: {{ game.building.progress }} of {{ game.building.devDays }}
            developer-days.
          </template>
          <template v-else-if="game.onSaas">Add-ons {{ formatCash(game.company.monthlyAddonCost) }} a month.</template>
          <template v-else>Nothing being built.</template>
        </p>
        <template #detail>
          <FeaturesPanel />
          <p class="modal-link"><RouterLink :to="page('product')">Open Product</RouterLink></p>
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
    </div>
  </template>
</template>
