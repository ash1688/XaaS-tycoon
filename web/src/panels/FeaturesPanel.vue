<script setup lang="ts">
import { computed } from "vue";
import { formatCash, formatCount, formatPrice } from "../api";
import { namesList, useGame } from "../game";

// Features to build, one at a time, or on SaaS the add-on shop.
const game = useGame();
const growthBoost = (multiplier: number) => `+${Math.round(100 * (multiplier - 1))}% growth`;
/** The customer types a feature pulls in among new users: " · pulls in professionals". */
const pulls = (appeal?: Partial<Record<string, number>>) => {
  const types = game.company?.customerMix.types ?? [];
  const names = Object.keys(appeal ?? {}).map((id) => types.find((t) => t.id === id)?.name.toLowerCase() ?? id);
  return names.length ? ` · pulls in ${namesList(names)}` : "";
};
// The MVP every game opens with: shown, with the launch day it gives, until it's done.
const mvp = computed(() => (game.company && !game.company.mvp.done ? game.company.mvp : null));
const launchDay = computed(() => game.company?.launch.day ?? null);

// Built features, or add-ons bought on SaaS.
const activeCount = computed(
  () => game.company?.features.filter((f) => f.status === "built" || f.status === "addon").length ?? 0,
);
</script>

<template>
  <section v-if="game.company" class="card" aria-labelledby="features-heading" data-testid="features">
    <div class="row-between panel-head">
      <h2 id="features-heading">{{ game.onSaas ? "Add-on shop" : "Features" }}</h2>
      <span class="muted">
        {{ activeCount }} of {{ game.company.features.length }} {{ game.onSaas ? "active" : "built" }}
      </span>
    </div>
    <div v-if="mvp" class="mvp" data-testid="mvp">
      <strong id="mvp-heading">MVP</strong>
      <p class="muted">
        Before anyone can use your product, your developers build a minimum viable product{{
          game.onSaas ? ": on SaaS, the storefront, payment gateways and the like" : ""
        }}. All their work goes into it, and no users arrive until it's done.
      </p>
      <div
        class="meter"
        role="progressbar"
        aria-labelledby="mvp-heading"
        aria-valuemin="0"
        :aria-valuemax="mvp.total"
        :aria-valuenow="mvp.progress"
        :aria-valuetext="`${mvp.progress} of ${mvp.total} developer-days`"
      >
        <div class="meter-fill building" :style="{ width: `${(100 * mvp.progress) / mvp.total}%` }"></div>
      </div>
      <p class="muted" data-testid="mvp-progress">
        {{ formatCount(mvp.progress) }} of {{ formatCount(mvp.total) }} developer-days.
        <template v-if="mvp.daysLeft !== null">
          {{ mvp.daysLeft }} day{{ mvp.daysLeft === 1 ? "" : "s" }} left with {{ game.company.developers }}
          developer{{ game.company.developers === 1 ? "" : "s" }}: more developers finish it sooner.
        </template>
        <strong v-else class="warn-text">No developers: hire some to build it.</strong>
      </p>
      <p data-testid="mvp-launch-day">
        <template v-if="launchDay !== null">Estimated launch: <strong>day {{ launchDay }}</strong>.</template>
        <template v-else-if="mvp.launchDay !== null">
          Done by day {{ mvp.launchDay }}. You launch once it's done and your servers are ready.
        </template>
        <template v-else>Estimated launch: not until someone builds it.</template>
      </p>
    </div>
    <template v-if="game.onSaas">
      <p class="features-note" data-testid="features-saas-note">
        On SaaS you don't build features yourself: you buy them as add-ons from the provider. They work straight away,
        but each one is billed <strong>per user, every month</strong>, so the bill grows as your users grow.
      </p>
      <p :class="['ops-needed', 'config-team', { warn: game.configTeamShort }]" data-testid="config-team">
        <span>
          Add-ons still need a configuration team of at least <strong>{{ game.configTeamNeeded }}</strong>
          developer{{ game.configTeamNeeded === 1 ? "" : "s" }}, counted in mids. Yours do the work of
          {{ formatCount(game.work("developers")) }}.
        </span>
        <span v-if="game.configTeamShort" class="badge">Hire {{ game.configTeamShort }} more to buy add-ons</span>
      </p>
      <p class="addon-bill" data-testid="addon-bill">
        Add-on bill at today's users: <strong>{{ formatCash(game.company.monthlyAddonCost) }}</strong> a month
      </p>
      <p v-for="gap in game.featureGaps" :key="gap.id" class="gap-note" data-testid="gap-shop-note">
        <span class="badge">Not in the shop</span> {{ gap.feature }}: no add-on offers it, and the platform's code isn't
        yours to change.
      </p>
    </template>
    <p v-else class="muted features-intro">
      Your developers build features, one at a time. Each developer does one developer-day of work a day.
    </p>
    <p
      v-if="game.leftBehind.length && !game.onSaas"
      class="lockin lockin-done"
      role="status"
      data-testid="addons-left-behind"
    >
      <span class="badge">Vendor lock-in</span>
      {{ namesList(game.leftBehind) }} stayed with the SaaS provider.
      {{ game.leftBehind.length === 1 ? "It's" : "They're" }} not built here: build
      {{ game.leftBehind.length === 1 ? "it" : "them" }} below to get the growth back.
    </p>
    <ul class="features">
      <li
        v-for="feature in game.company.features"
        :key="feature.id"
        :class="feature.status"
        :data-feature="feature.id"
        :data-status="feature.status"
      >
        <div class="row-between feature-head">
          <div class="feature-info">
            <strong :id="`feature-${feature.id}`">{{ feature.name }}</strong>
            <span class="muted">{{ feature.blurb }}</span>
            <span v-if="game.onSaas" class="muted feature-cost" :data-testid="`addon-price-${feature.id}`">
              {{ formatPrice(feature.addonPricePerUser) }} per user a month · {{ growthBoost(feature.growthMultiplier) }}{{ pulls(feature.appeal) }}
            </span>
            <span v-else class="muted feature-cost">
              {{ feature.devDays }} developer-days · {{ growthBoost(feature.growthMultiplier) }}{{ pulls(feature.appeal) }}
            </span>
          </div>
          <span v-if="feature.status === 'built'" class="badge built-badge">Built</span>
          <span v-else-if="feature.status === 'addon'" class="badge built-badge">Active</span>
          <button
            v-else-if="feature.status === 'notStarted' && game.onSaas"
            class="ghost"
            :disabled="game.busy || game.over || game.configTeamShort > 0"
            :aria-label="`Buy ${feature.name} add-on`"
            :title="game.configTeamShort ? `Hire ${game.configTeamShort} more developers to configure add-ons` : undefined"
            @click="game.act({ type: 'buyAddon', feature: feature.id })"
          >
            Buy
          </button>
          <button
            v-else-if="feature.status === 'notStarted' && !game.onSaas"
            class="ghost"
            :disabled="game.busy || game.over || !!game.building || !!mvp"
            :aria-label="`Build ${feature.name}`"
            :title="
              mvp
                ? 'Your developers are building the MVP first'
                : game.building
                  ? `Your developers are busy building ${game.building.name}`
                  : undefined
            "
            @click="game.act({ type: 'buildFeature', feature: feature.id })"
          >
            Build
          </button>
        </div>
        <div v-if="feature.status === 'building'" class="feature-progress">
          <div
            class="meter"
            role="progressbar"
            :aria-labelledby="`feature-${feature.id}`"
            aria-valuemin="0"
            :aria-valuemax="feature.devDays"
            :aria-valuenow="feature.progress"
            :aria-valuetext="`${feature.progress} of ${feature.devDays} developer-days`"
          >
            <div class="meter-fill building" :style="{ width: `${(100 * feature.progress) / feature.devDays}%` }"></div>
          </div>
          <p class="muted" :data-testid="`feature-progress-${feature.id}`">
            {{ formatCount(feature.progress) }} of {{ feature.devDays }} developer-days.
            <template v-if="feature.daysLeft !== null">
              {{ feature.daysLeft }} day{{ feature.daysLeft === 1 ? "" : "s" }} left with {{ game.company.developers }}
              developer{{ game.company.developers === 1 ? "" : "s" }}.
            </template>
            <strong v-else-if="game.onSaas" class="muted" :data-testid="`feature-paused-${feature.id}`">
              Paused: on SaaS you buy add-ons instead. It carries on if you leave SaaS.
            </strong>
            <strong v-else class="warn-text">No developers: hire some to carry on.</strong>
          </p>
        </div>
      </li>
    </ul>
  </section>
</template>
