<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { CompanyStatus, MetaView, TeacherGamesView, TeacherGameView } from "@xaas/server/api-types";
import { api, formatCash, formatCount, formatUptime, RequestError } from "../api";

// Recent games grouped by code, refreshed while the tab is visible so the teacher can watch during a lesson.
const emit = defineEmits<{ signedOut: [] }>();

const REFRESH_MS = 20_000;
const WINDOWS = [
  { hours: 1, label: "1h" },
  { hours: 3, label: "3h" },
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
];
// Below this, uptime is shown as a problem: students will be losing users to outages.
const LOW_UPTIME = 95;

const meta = ref<MetaView>();
const games = ref<TeacherGamesView>();
// Undefined until the first load, which takes the server's default window.
const hours = ref<number>();
const error = ref("");
const updatedAt = ref<Date>();
let timer: ReturnType<typeof setInterval> | undefined;

const STATUS_LABELS = { active: "Active", retired: "Retired", bankrupt: "Bankrupt", finished: "Finished" } as const;
const STATUS_BADGES = { active: "", retired: "retired-badge", bankrupt: "warn-badge", finished: "done-badge" } as const;

// "Rent VMs (IaaS)" -> "IaaS": short enough for a table column.
function modelName(id: string) {
  const name = meta.value?.models.find((m) => m.id === id)?.name ?? id;
  const short = /\(([^)]+)\)$/.exec(name)?.[1] ?? name;
  return short.charAt(0).toUpperCase() + short.slice(1);
}
const productName = (id: string) => meta.value?.productTypes.find((p) => p.id === id)?.name ?? id;
const migrating = (g: TeacherGameView) => g.status === "active" && g.migratingTo;
const statusLabel = (s: CompanyStatus) => STATUS_LABELS[s];

function playedAgo(iso: string) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hrs = Math.floor(minutes / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.floor(hrs / 24)} d ago`;
}

async function load() {
  try {
    games.value = await api.teacherGames(hours.value);
    hours.value = games.value.hours;
    updatedAt.value = new Date();
    error.value = "";
  } catch (e) {
    if (e instanceof RequestError && e.status === 401) return emit("signedOut");
    error.value = (e as Error).message;
  }
}

function pickWindow(h: number) {
  hours.value = h;
  load();
}

function start() {
  stop();
  timer = setInterval(load, REFRESH_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

// No point polling while nobody can see it: catch up as soon as the tab is back.
function onVisibility() {
  if (document.hidden) return stop();
  load();
  start();
}

onMounted(async () => {
  document.addEventListener("visibilitychange", onVisibility);
  // Without meta, models and products show by id: not worth holding the games back for.
  await Promise.all([
    api.meta().then((m) => (meta.value = m), () => {}),
    load(),
  ]);
  if (!document.hidden) start();
});

onUnmounted(() => {
  stop();
  document.removeEventListener("visibilitychange", onVisibility);
});

const formatCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
const formatTime = (d: Date) => d.toLocaleTimeString("en-GB", { timeStyle: "short" });
</script>

<template>
  <section class="card live" aria-labelledby="live-heading" data-testid="live-dashboard">
    <div class="row-between live-head">
      <h2 id="live-heading">Live games</h2>
      <div class="windows" role="group" aria-label="Show games played in the last">
        <button
          v-for="w in WINDOWS"
          :key="w.hours"
          :class="['ghost', { on: hours === w.hours }]"
          :aria-pressed="hours === w.hours"
          @click="pickWindow(w.hours)"
        >
          {{ w.label }}
        </button>
      </div>
    </div>
    <p v-if="hours" class="muted live-note">
      Games played in the last {{ hours === 168 ? "7 days" : `${hours} hour${hours === 1 ? "" : "s"}` }}.
      Updates every {{ REFRESH_MS / 1000 }} seconds<template v-if="updatedAt">, last at {{ formatTime(updatedAt) }}</template>.
      Click a company to see how it's doing.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="games">
      <p v-if="!games.codes.length" class="muted">No games in this window yet.</p>
      <section v-for="group in games.codes" :key="group.code" class="live-code" :data-code="group.code">
        <div class="row-between live-code-head">
          <h3 class="mono">{{ formatCode(group.code) }}</h3>
          <span class="muted">{{ group.companies.length }} compan{{ group.companies.length === 1 ? "y" : "ies" }}</span>
        </div>
        <div class="table-scroll">
          <table class="live-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Model</th>
                <th class="num">Day</th>
                <th class="num">Cash</th>
                <th class="num">Users</th>
                <th class="num">Uptime</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in group.companies" :key="g.id" :data-company="g.id">
                <td>
                  <RouterLink :to="`/staff/companies/${g.id}`" class="live-name">{{ g.name }}</RouterLink>
                  <small class="muted">{{ productName(g.productType) }}</small>
                </td>
                <td>
                  {{ modelName(g.model) }}
                  <span
                    v-if="migrating(g)"
                    class="badge migrating-badge"
                    :title="`Migrating to ${modelName(g.migratingTo!)}`"
                    data-testid="migrating"
                  >
                    → {{ modelName(g.migratingTo!) }}
                  </span>
                </td>
                <td class="num" data-testid="live-day">{{ g.day }}<span class="muted">/{{ g.finalDay }}</span></td>
                <td :class="['num', { neg: g.cash < 0 }]">{{ formatCash(g.cash) }}</td>
                <td class="num">{{ formatCount(g.users) }}</td>
                <td :class="['num', { neg: g.uptime < LOW_UPTIME }]">{{ formatUptime(g.uptime) }}</td>
                <td>
                  <span v-if="g.status !== 'active'" :class="['badge', STATUS_BADGES[g.status]]">
                    {{ statusLabel(g.status) }}
                  </span>
                  <span v-else>{{ statusLabel(g.status) }}</span>
                  <small class="muted">{{ playedAgo(g.updatedAt) }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </section>
</template>
