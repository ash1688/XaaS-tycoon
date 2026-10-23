<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { CompanyStatus, MetaView, TeacherGamesView, TeacherGameView } from "@xaas/server/api-types";
import { api, formatCash, formatCount, formatUptime, RequestError } from "../api";

// Recent games grouped by code, refreshed while the tab is visible so the teacher can watch during a lesson. The
// Archived tab lists games and codes the teacher has put away, where they can be brought back or deleted for good.
const emit = defineEmits<{ signedOut: []; codesChanged: [] }>();

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
const showArchived = ref(false);
// A game or code waiting on the teacher to confirm its deletion or ending, shown under its code's table.
const confirming = ref<
  | { kind: "game"; id: string }
  | { kind: "code"; code: string }
  | { kind: "endGame"; id: string }
  | { kind: "endCode"; code: string }
>();
const busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const STATUS_LABELS = { active: "Active", retired: "Retired", liquidated: "Liquidated", finished: "Finished" } as const;
const STATUS_BADGES = { active: "", retired: "retired-badge", liquidated: "warn-badge", finished: "done-badge" } as const;

// "Rent VMs (IaaS)" -> "IaaS": short enough for a table column.
function modelName(id: string) {
  const name = meta.value?.models.find((m) => m.id === id)?.name ?? id;
  const short = /\(([^)]+)\)$/.exec(name)?.[1] ?? name;
  return short.charAt(0).toUpperCase() + short.slice(1);
}
const productName = (id: string) => meta.value?.productTypes.find((p) => p.id === id)?.name ?? id;
const migrating = (g: TeacherGameView) => g.status === "active" && g.migratingTo;
const statusLabel = (g: TeacherGameView) => (g.endedByTeacher ? "Ended" : STATUS_LABELS[g.status as CompanyStatus]);
const activeCount = (companies: TeacherGameView[]) => companies.filter((g) => g.status === "active").length;
// Below good satisfaction, growth slows and users leave: shown as a problem, like low uptime.
const lowSatisfaction = (g: TeacherGameView) => g.satisfaction < (meta.value?.goodSatisfaction ?? 70);
// Signed, so profit or loss doesn't rest on colour alone.
const signed = (n: number) => `${n < 0 ? "−" : "+"}${formatCash(Math.abs(n))}`;
function loanLabel(remaining: number | null) {
  if (remaining === null) return "No";
  return remaining > 0 ? `${formatCash(remaining)} left` : "Repaid";
}

function playedAgo(iso: string) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hrs = Math.floor(minutes / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.floor(hrs / 24)} d ago`;
}

async function load() {
  try {
    const archived = showArchived.value;
    const result = archived ? await api.archivedGames() : await api.teacherGames(hours.value);
    // The teacher switched tabs while this was loading: the other tab's load wins.
    if (archived !== showArchived.value) return;
    games.value = result;
    if (result.hours !== null) hours.value = result.hours;
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

function pickTab(archived: boolean) {
  if (showArchived.value === archived) return;
  showArchived.value = archived;
  confirming.value = undefined;
  games.value = undefined;
  load();
}

// Runs an archive, unarchive or delete, then shows the list as it is now.
async function act(run: () => Promise<unknown>, codesChanged = false) {
  error.value = "";
  busy.value = true;
  try {
    await run();
    confirming.value = undefined;
    if (codesChanged) emit("codesChanged");
  } catch (e) {
    if (e instanceof RequestError && e.status === 401) return emit("signedOut");
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
  await load();
}

const archiveGame = (id: string) => act(() => api.archiveGame(id));
const unarchiveGame = (id: string) => act(() => api.unarchiveGame(id));
const deleteGame = (id: string) => act(() => api.deleteGame(id));
const unarchiveCode = (code: string) => act(() => api.unarchiveCode(code), true);
const deleteCode = (code: string) => act(() => api.deleteCode(code), true);
const endGame = (id: string) => act(() => api.endGame(id));
const endCodeGames = (code: string) => act(() => api.endCodeGames(code));

const confirmingGame = (code: string, kind: "game" | "endGame" = "game") => {
  const c = confirming.value;
  if (c?.kind !== kind) return undefined;
  return games.value?.codes.find((g) => g.code === code)?.companies.find((g) => g.id === c.id);
};
const confirmingCode = (code: string, kind: "code" | "endCode" = "code") => {
  const c = confirming.value;
  return c?.kind === kind && c.code === code;
};

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

// The staff page reloads the dashboard after archiving or deleting a code from its codes table.
defineExpose({ load });

const formatCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
const companiesLabel = (n: number) => `${n} compan${n === 1 ? "y" : "ies"}`;
const formatTime = (d: Date) => d.toLocaleTimeString("en-GB", { timeStyle: "short" });
</script>

<template>
  <section class="card live" aria-labelledby="live-heading" data-testid="live-dashboard">
    <div class="row-between live-head">
      <h2 id="live-heading">{{ showArchived ? "Archived games" : "Live games" }}</h2>
      <div class="live-controls">
        <div v-if="!showArchived" class="windows" role="group" aria-label="Show games played in the last">
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
        <div class="windows" role="group" aria-label="Which games">
          <button :class="['ghost', { on: !showArchived }]" :aria-pressed="!showArchived" @click="pickTab(false)">
            Live
          </button>
          <button :class="['ghost', { on: showArchived }]" :aria-pressed="showArchived" @click="pickTab(true)">
            Archived
          </button>
        </div>
      </div>
    </div>
    <p v-if="showArchived" class="muted live-note">
      Archived games and codes, however old. Archiving a game only hides it from your live view: the student can still
      play it. An archived code stops working for students until you unarchive it.
    </p>
    <p v-else-if="hours" class="muted live-note">
      Games played in the last {{ hours === 168 ? "7 days" : `${hours} hour${hours === 1 ? "" : "s"}` }}.
      Updates every {{ REFRESH_MS / 1000 }} seconds<template v-if="updatedAt">, last at {{ formatTime(updatedAt) }}</template>.
      Click a company to see how it's doing. Archive a game to move it off this list.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="games">
      <p v-if="!games.codes.length" class="muted">
        {{ showArchived ? "Nothing archived yet." : "No games in this window yet." }}
      </p>
      <section v-for="group in games.codes" :key="group.code" class="live-code" :data-code="group.code">
        <div class="row-between live-code-head">
          <h3 class="mono">{{ formatCode(group.code) }}</h3>
          <div class="live-code-actions">
            <span v-if="group.archived" class="badge retired-badge">Code archived</span>
            <span class="muted">{{ companiesLabel(group.companies.length) }}</span>
            <button
              v-if="!group.archived && activeCount(group.companies)"
              class="ghost small"
              :disabled="busy"
              :aria-label="`End every game under code ${formatCode(group.code)}`"
              @click="confirming = { kind: 'endCode', code: group.code }"
            >
              End all games
            </button>
            <template v-if="group.archived">
              <button
                class="ghost small"
                :disabled="busy"
                :aria-label="`Unarchive code ${formatCode(group.code)}`"
                @click="unarchiveCode(group.code)"
              >
                Unarchive code
              </button>
              <button
                class="ghost small danger"
                :disabled="busy"
                :aria-label="`Delete code ${formatCode(group.code)}`"
                @click="confirming = { kind: 'code', code: group.code }"
              >
                Delete code
              </button>
            </template>
          </div>
        </div>
        <div v-if="group.companies.length" class="table-scroll">
          <table class="live-table">
            <thead>
              <tr>
                <th class="c-company">Company</th>
                <th class="c-model col-mid">Model</th>
                <th class="c-preset col-wide">Preset</th>
                <th class="c-day num">Day</th>
                <th class="c-cash num col-mid">Cash</th>
                <th class="c-users num">Users</th>
                <th class="c-income num">Income a day</th>
                <th class="c-profit num">Profit</th>
                <th class="c-satisfaction num">Satisfaction</th>
                <th class="c-loan col-wide">Loan</th>
                <th class="c-uptime num col-mid">Uptime</th>
                <th class="c-status">Status</th>
                <th class="c-actions"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in group.companies" :key="g.id" :data-company="g.id">
                <td>
                  <RouterLink :to="`/staff/companies/${g.id}`" class="live-name">{{ g.name }}</RouterLink>
                  <small class="muted">{{ productName(g.productType) }}</small>
                  <small>
                    <RouterLink :to="`/staff/companies/${g.id}/timeline`" data-testid="live-timeline">
                      {{ g.player }}: timeline
                    </RouterLink>
                  </small>
                </td>
                <td class="col-mid">
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
                <td class="live-preset col-wide" :title="g.preset" data-testid="live-preset">{{ g.preset }}</td>
                <td class="num" data-testid="live-day">{{ g.day }}<span class="muted">/{{ g.finalDay }}</span></td>
                <td :class="['num', 'col-mid', { neg: g.cash < 0 }]">{{ formatCash(g.cash) }}</td>
                <td class="num" data-testid="live-users">
                  {{ formatCount(g.users) }}
                  <small class="muted" data-testid="live-paid-free">
                    {{ formatCount(g.paidUsers) }} paid · {{ formatCount(g.freeUsers) }} free
                  </small>
                </td>
                <td class="num" data-testid="live-income">{{ formatCash(g.lastDayIncome) }}</td>
                <td :class="['num', g.profit < 0 ? 'neg' : 'pos']" data-testid="live-profit">{{ signed(g.profit) }}</td>
                <td :class="['num', { neg: lowSatisfaction(g) }]" data-testid="live-satisfaction">{{ g.satisfaction }}%</td>
                <td class="col-wide" data-testid="live-loan">{{ loanLabel(g.loanRemaining) }}</td>
                <td :class="['num', 'col-mid', { neg: g.uptime < LOW_UPTIME }]">{{ formatUptime(g.uptime) }}</td>
                <td>
                  <span v-if="g.status !== 'active'" :class="['badge', STATUS_BADGES[g.status]]" data-testid="live-status">
                    {{ statusLabel(g) }}
                  </span>
                  <span v-else data-testid="live-status">{{ statusLabel(g) }}</span>
                  <small class="muted">{{ playedAgo(g.updatedAt) }}</small>
                </td>
                <td class="row-actions">
                  <button
                    v-if="g.status === 'active' && !group.archived"
                    class="ghost small"
                    :disabled="busy"
                    :aria-label="`End ${g.name}`"
                    @click="confirming = { kind: 'endGame', id: g.id }"
                  >
                    End game
                  </button>
                  <button
                    v-if="!showArchived"
                    class="ghost small"
                    :disabled="busy"
                    :aria-label="`Archive ${g.name}`"
                    @click="archiveGame(g.id)"
                  >
                    Archive
                  </button>
                  <button
                    v-else-if="!group.archived"
                    class="ghost small"
                    :disabled="busy"
                    :aria-label="`Unarchive ${g.name}`"
                    @click="unarchiveGame(g.id)"
                  >
                    Unarchive
                  </button>
                  <button
                    class="ghost small danger"
                    :disabled="busy"
                    :aria-label="`Delete ${g.name}`"
                    @click="confirming = { kind: 'game', id: g.id }"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          v-if="confirmingGame(group.code, 'endGame')"
          class="retire-confirm"
          role="group"
          :aria-label="`End ${confirmingGame(group.code, 'endGame')!.name}?`"
        >
          <p>
            End <strong>{{ confirmingGame(group.code, 'endGame')!.name }}</strong> now? It's scored as it stands, and the
            student sees its summary. It can't be played again.
          </p>
          <div class="retire-actions">
            <button class="danger-fill" :disabled="busy" @click="endGame(confirmingGame(group.code, 'endGame')!.id)">
              Yes, end it
            </button>
            <button class="ghost" :disabled="busy" @click="confirming = undefined">Cancel</button>
          </div>
        </div>
        <div
          v-if="confirmingCode(group.code, 'endCode')"
          class="retire-confirm"
          role="group"
          :aria-label="`End every game under code ${formatCode(group.code)}?`"
        >
          <p>
            End the {{ companiesLabel(activeCount(group.companies)) }} still being played under code
            <strong class="mono">{{ formatCode(group.code) }}</strong>? Each is scored as it stands, and students see their
            summaries. They can't be played again.
          </p>
          <div class="retire-actions">
            <button class="danger-fill" :disabled="busy" @click="endCodeGames(group.code)">Yes, end them</button>
            <button class="ghost" :disabled="busy" @click="confirming = undefined">Cancel</button>
          </div>
        </div>
        <div
          v-if="confirmingGame(group.code)"
          class="retire-confirm"
          role="group"
          :aria-label="`Delete ${confirmingGame(group.code)!.name}?`"
        >
          <p>
            Delete <strong>{{ confirmingGame(group.code)!.name }}</strong> permanently? The game and its summary are
            removed for you and the student. This can't be undone.
          </p>
          <div class="retire-actions">
            <button class="danger-fill" :disabled="busy" @click="deleteGame(confirmingGame(group.code)!.id)">
              Yes, delete it
            </button>
            <button class="ghost" :disabled="busy" @click="confirming = undefined">Cancel</button>
          </div>
        </div>
        <div
          v-if="confirmingCode(group.code)"
          class="retire-confirm"
          role="group"
          :aria-label="`Delete code ${formatCode(group.code)}?`"
        >
          <p>
            Delete code <strong class="mono">{{ formatCode(group.code) }}</strong> and its
            {{ companiesLabel(group.companies.length) }} permanently? Students can't use the code again, and every game
            under it is removed. This can't be undone.
          </p>
          <div class="retire-actions">
            <button class="danger-fill" :disabled="busy" @click="deleteCode(group.code)">
              Yes, delete the code
            </button>
            <button class="ghost" :disabled="busy" @click="confirming = undefined">Cancel</button>
          </div>
        </div>
      </section>
    </template>
  </section>
</template>
