<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { MetaView, PlayEventKind, PlayEventView, PlaySnapshot, TimelineView } from "@xaas/server/api-types";
import { api, formatCash, formatCount, formatPrice, formatUptime, RequestError } from "../api";

// One company's activity in the playtest log, oldest first: what the student did in the game and in the UI, each game
// event with the key numbers just after it. Opened from the dashboard or the company's summary.
const props = defineProps<{ id: string }>();

const meta = ref<MetaView>();
const data = ref<TimelineView>();
const kind = ref<PlayEventKind>();
const error = ref("");
const signedOut = ref(false);
const busy = ref(false);
const confirmingDelete = ref(false);
const deletedNote = ref("");

const FILTERS = [
  { kind: undefined, label: "All" },
  { kind: "game", label: "Game" },
  { kind: "ui", label: "UI" },
] as const;

async function load() {
  try {
    data.value = await api.timeline(props.id, kind.value);
    error.value = "";
  } catch (e) {
    if (e instanceof RequestError && e.status === 401) signedOut.value = true;
    else error.value = (e as Error).message;
  }
}

function pick(k: PlayEventKind | undefined) {
  if (kind.value === k) return;
  kind.value = k;
  load();
}

async function deleteLogs() {
  busy.value = true;
  try {
    const { deleted } = await api.deleteGameLogs(props.id);
    deletedNote.value = `Deleted ${formatCount(deleted)} event${deleted === 1 ? "" : "s"}.`;
    confirmingDelete.value = false;
    await load();
  } catch (e) {
    if (e instanceof RequestError && e.status === 401) signedOut.value = true;
    else error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  // Without meta, models and products show by id: not worth holding the timeline back for.
  await Promise.all([api.meta().then((m) => (meta.value = m), () => {}), load()]);
});

const modelName = (id: string) => meta.value?.models.find((m) => m.id === id)?.name ?? id;
const productName = (id: string) => meta.value?.productTypes.find((p) => p.id === id)?.name ?? id;
const poolName = (id: unknown) => meta.value?.staff.find((s) => s.id === id)?.personName ?? String(id);
const featureName = (id: unknown) =>
  meta.value?.productTypes.flatMap((p) => p.features).find((f) => f.id === id)?.name ?? String(id);
const formatCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
const pageName = (id: unknown) => {
  const text = String(id);
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const seconds = (ms: unknown) => `${Math.round(Number(ms) / 100) / 10}s`;

/** What happened, in words. */
function describe(e: PlayEventView): string {
  const p = e.params;
  if (e.kind === "ui") {
    switch (e.type) {
      case "page":
        return `Visited ${pageName(p.page)}`;
      case "modal":
        return `Opened “${String(p.modal).replace(/-/g, " ")}” for ${seconds(p.ms)}`;
      case "pricePreview": {
        const prices = (p.prices as number[] | undefined)?.map(formatPrice).join(", ") || "no other price";
        return `Previewed ${prices}: ${p.confirmed ? "then set a price" : "didn't set one"}`;
      }
      case "quote":
        return p.kind === "loan"
          ? `Viewed the loan terms: ${p.confirmed ? "took the loan" : "didn't take it"}`
          : `Viewed the quote to migrate to ${modelName(String(p.target))}: ${p.confirmed ? "started it" : "didn't start it"}`;
      case "control":
        return `Used ${String(p.control).replace(/-/g, " ")}${p.value ? `: ${String(p.value).replace(/-/g, " ")}` : ""}`;
    }
  }
  switch (e.type) {
    case "start":
      return `Started ${productName(String(p.productType))} on ${modelName(String(p.model))}${p.takeLoan ? ", with the start loan" : ""}`;
    case "end":
      return `Game ended: ${p.status}`;
    case "continue": {
      const events = p.events as string[] | undefined;
      return events?.length ? `Continue (events: ${events.join(", ")})` : "Continue";
    }
    case "hire":
      return `Hired one ${p.agency ? "agency " : ""}${poolName(p.pool)}`;
    case "letGo":
      return `Let go one ${p.agency ? "agency " : ""}${poolName(p.pool)}`;
    case "moveStaff":
      return `Moved one ${poolName(p.from ?? "?")} to ${poolName(p.to)}`;
    case "buildFeature":
      return `Started building ${featureName(p.feature)}`;
    case "buyAddon":
      return `Bought the ${featureName(p.feature)} add-on`;
    case "startMigration":
      return `Started migrating to ${modelName(String(p.model))}`;
    case "setPrice":
      return `Set the price to ${formatPrice(Number(p.price))}`;
    case "rentServer":
    case "buyServer":
      return `${e.type === "rentServer" ? "Rented" : "Bought"} a ${p.size} ${p.server}`;
    case "cancelServer":
    case "sellServer":
      return `${e.type === "cancelServer" ? "Cancelled" : "Sold"} server ${p.id}`;
    case "buyRack":
      return `Bought a ${p.size} rack`;
    case "sellRack":
      return `Sold rack ${p.id}`;
    case "setInstances":
      return `Set ${p.count} app instance${p.count === 1 ? "" : "s"}`;
    case "setManagedService":
      return `Set the managed ${p.service} to ${p.size ?? "off"}`;
    case "takeLoan":
      return "Took a bank loan";
    case "repayLoan":
      return "Paid off the bank loan early";
  }
  return e.type;
}

/** The key numbers, in one line. */
function numbers(s: PlaySnapshot) {
  const parts = [
    `${formatCash(s.cash)} cash`,
    `${formatCount(s.paidUsers)} paid · ${formatCount(s.freeUsers)} free`,
    `${formatCash(s.dailyIncome)} a day`,
    `satisfaction ${s.satisfaction}%`,
    `uptime ${formatUptime(s.uptime)}`,
  ];
  if (s.noCapacity) parts.push(`${s.tier ? s.tier.toUpperCase() : "capacity"}: demand with no capacity`);
  else if (s.tierUse !== null) parts.push(`${s.tier ? s.tier.toUpperCase() : "capacity"} ${s.tierUse}% used`);
  parts.push(`${s.developers} dev · ${s.ops} ops · ${s.support} support`);
  if (s.loan !== "none") parts.push(s.loan === "repaying" ? `loan ${formatCash(s.loanRemaining ?? 0)} left` : "loan repaid");
  return parts;
}

const time = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const formatAt = (iso: string) => time.format(new Date(iso));
const counts = computed(() => {
  const events = data.value?.events ?? [];
  return { game: events.filter((e) => e.kind === "game").length, ui: events.filter((e) => e.kind === "ui").length };
});
</script>

<template>
  <p class="back"><RouterLink to="/staff">← Staff dashboard</RouterLink></p>
  <section v-if="signedOut" class="card narrow">
    <p>Your staff session has ended. <RouterLink to="/staff">Sign in again</RouterLink> to see this timeline.</p>
  </section>
  <p v-else-if="error" class="error" role="alert">{{ error }}</p>
  <template v-else-if="data">
    <div class="row-between staff-head">
      <h1>Activity: {{ data.player }}</h1>
      <div class="staff-head-actions">
        <RouterLink :to="`/staff/companies/${data.id}`" class="button-link ghost">Summary</RouterLink>
      </div>
    </div>
    <p class="muted timeline-meta">
      <strong>{{ data.name }}</strong> · code <span class="mono">{{ formatCode(data.code) }}</span> ·
      {{ productName(data.productType) }} · preset {{ data.preset }} · {{ data.status }}.
      The export names this company <strong>{{ data.player }}</strong> only, and its student
      <strong>{{ data.tester }}</strong>.
    </p>

    <section class="card" aria-labelledby="timeline-heading" data-testid="timeline">
      <div class="row-between live-head">
        <h2 id="timeline-heading">Timeline</h2>
        <div class="windows" role="group" aria-label="Show events">
          <button
            v-for="f in FILTERS"
            :key="f.label"
            :class="['ghost', { on: kind === f.kind }]"
            :aria-pressed="kind === f.kind"
            @click="pick(f.kind)"
          >
            {{ f.label }}
          </button>
          <button class="ghost" :disabled="busy" @click="load">Refresh</button>
        </div>
      </div>
      <p class="muted live-note" data-testid="timeline-count">
        {{ formatCount(data.events.length) }} event{{ data.events.length === 1 ? "" : "s" }}<template v-if="!kind">:
          {{ formatCount(counts.game) }} game, {{ formatCount(counts.ui) }} UI</template>.
        <template v-if="data.truncated">Only the latest are shown: the export has them all.</template>
      </p>
      <p v-if="deletedNote" class="muted" role="status">{{ deletedNote }}</p>

      <p v-if="!data.events.length" class="muted">Nothing logged yet.</p>
      <ol v-else class="timeline">
        <li
          v-for="e in data.events"
          :key="e.id"
          :class="['tl-event', e.kind, { refused: e.ok === false }]"
          :data-type="e.type"
          :data-kind="e.kind"
        >
          <div class="tl-when">
            <time :datetime="e.at">{{ formatAt(e.at) }}</time>
            <span class="muted">Day {{ e.day }}</span>
          </div>
          <div class="tl-what">
            <p class="tl-title">
              <span :class="['badge', 'tl-kind', e.kind]">{{ e.kind === "game" ? "Game" : "UI" }}</span>
              <span>{{ describe(e) }}</span>
              <span v-if="e.ok === false" class="badge warn-badge" data-testid="tl-refused">Refused: {{ e.error }}</span>
            </p>
            <p v-if="e.snapshot" class="tl-numbers muted">
              <span v-for="n in numbers(e.snapshot)" :key="n">{{ n }}</span>
            </p>
          </div>
        </li>
      </ol>
    </section>

    <section class="card" aria-labelledby="timeline-delete-heading">
      <h2 id="timeline-delete-heading">Delete this game's logs</h2>
      <p class="muted">
        Removes every event logged for this game. The game itself, and its pseudonym, stay. Deleting the game also
        deletes its logs.
      </p>
      <button v-if="!confirmingDelete" class="ghost danger" :disabled="busy" @click="confirmingDelete = true">
        Delete logs
      </button>
      <div v-else class="retire-confirm" role="group" aria-label="Delete this game's logs?">
        <p>Delete all of {{ data.player }}'s logged events permanently? This can't be undone.</p>
        <div class="retire-actions">
          <button class="danger-fill" :disabled="busy" @click="deleteLogs">Yes, delete them</button>
          <button class="ghost" :disabled="busy" @click="confirmingDelete = false">Cancel</button>
        </div>
      </div>
    </section>
  </template>
</template>
