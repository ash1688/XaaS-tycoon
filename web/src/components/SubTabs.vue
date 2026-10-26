<script setup lang="ts" generic="T extends string">
import { computed, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";

// A page's sub-tabs, one panel showing at a time. The open tab is in the URL (?tab=price), so a reload or a link keeps
// it; with none given, or one the page doesn't have now, it's the fallback. Arrow keys, Home and End move along the
// tabs and open the one they land on. `name` sets the ids and test ids: product-tab-price, product-panel-price.
const props = defineProps<{ name: string; label: string; tabs: { id: T; name: string }[]; fallback: T }>();
defineSlots<{ default(props: { current: T }): unknown }>();
const route = useRoute();
const router = useRouter();

const current = computed<T>(() => props.tabs.find((t) => t.id === route.query.tab)?.id ?? props.fallback);

function pick(id: T) {
  if (route.query.tab !== id) router.replace({ query: { ...route.query, tab: id }, hash: route.hash });
}

async function onKey(e: KeyboardEvent) {
  const i = props.tabs.findIndex((t) => t.id === current.value);
  const last = props.tabs.length - 1;
  const next =
    e.key === "ArrowRight" ? (i === last ? 0 : i + 1)
    : e.key === "ArrowLeft" ? (i <= 0 ? last : i - 1)
    : e.key === "Home" ? 0
    : e.key === "End" ? last
    : null;
  const tab = next === null ? undefined : props.tabs[next];
  if (!tab) return;
  e.preventDefault();
  pick(tab.id);
  await nextTick();
  document.getElementById(`${props.name}-tab-${tab.id}`)?.focus();
}
</script>

<template>
  <div class="subtabs" role="tablist" :aria-label="label" :data-testid="`${name}-tabs`" @keydown="onKey">
    <button
      v-for="t in tabs"
      :id="`${name}-tab-${t.id}`"
      :key="t.id"
      type="button"
      role="tab"
      :class="['subtab', { on: t.id === current }]"
      :aria-selected="t.id === current"
      :aria-controls="`${name}-panel-${t.id}`"
      :tabindex="t.id === current ? 0 : -1"
      :data-tab="t.id"
      @click="pick(t.id)"
    >
      {{ t.name }}
    </button>
  </div>
  <div
    :id="`${name}-panel-${current}`"
    role="tabpanel"
    :aria-labelledby="`${name}-tab-${current}`"
    class="subtab-panel"
    :data-testid="`${name}-panel-${current}`"
  >
    <slot :current="current" />
  </div>
</template>
