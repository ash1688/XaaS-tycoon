<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { LogStatsView, PlayEventKind } from "@xaas/server/api-types";
import { api, formatCount, logExportUrl, RequestError } from "../api";

// The playtest log, for the whole class: how much there is, an export to CSV or JSON with filters, and deleting it by
// code or all at once. Each game's own timeline, and deleting its logs, are on the game's timeline page.
const emit = defineEmits<{ signedOut: [] }>();

const stats = ref<LogStatsView>();
const presets = ref<string[]>([]);
const code = ref("");
const preset = ref("");
const kind = ref<PlayEventKind | "">("");
const from = ref("");
const to = ref("");
const error = ref("");
const note = ref("");
const busy = ref(false);
const confirming = ref<"code" | "all">();

// A code as the teacher types it, spaces and all; only a full one filters.
const cleanCode = computed(() => code.value.replace(/\s/g, ""));
const codeValid = computed(() => /^\d{8}$/.test(cleanCode.value));
const codeProblem = computed(() => (cleanCode.value && !codeValid.value ? "A code is 8 digits." : ""));
const rangeProblem = computed(() => (from.value && to.value && from.value > to.value ? "The first day is after the last." : ""));

// The date inputs are whole days in the teacher's time zone: from the start of the first to the end of the last.
const filters = computed(() => ({
  code: codeValid.value ? cleanCode.value : undefined,
  preset: preset.value || undefined,
  kind: kind.value || undefined,
  from: from.value ? new Date(`${from.value}T00:00:00`).toISOString() : undefined,
  to: to.value ? new Date(`${to.value}T23:59:59.999`).toISOString() : undefined,
}));
const csvUrl = computed(() => logExportUrl("csv", filters.value));
const jsonUrl = computed(() => logExportUrl("json", filters.value));
const canExport = computed(() => !codeProblem.value && !rangeProblem.value);

function failed(e: unknown) {
  if (e instanceof RequestError && e.status === 401) emit("signedOut");
  else error.value = (e as Error).message;
}

async function load() {
  try {
    const [s, p] = await Promise.all([api.logStats(), api.presets()]);
    stats.value = s;
    // Games started before presets had names are labelled Custom.
    presets.value = [...new Set([...p.presets.map((x) => x.name), "Custom"])];
  } catch (e) {
    failed(e);
  }
}

async function remove(which: "code" | "all") {
  error.value = "";
  busy.value = true;
  try {
    const { deleted } = which === "code" ? await api.deleteCodeLogs(cleanCode.value) : await api.deleteAllLogs();
    note.value = `Deleted ${formatCount(deleted)} event${deleted === 1 ? "" : "s"}.`;
    confirming.value = undefined;
  } catch (e) {
    failed(e);
  } finally {
    busy.value = false;
  }
  await load();
}

onMounted(load);
defineExpose({ load });

const formatCode = (c: string) => `${c.slice(0, 4)} ${c.slice(4)}`;
</script>

<template>
  <section class="card playtest-logs" aria-labelledby="logs-heading" data-testid="playtest-logs">
    <div class="row-between live-head">
      <h2 id="logs-heading">Playtest logs</h2>
      <button class="ghost small" :disabled="busy" @click="load">Refresh</button>
    </div>
    <p class="muted live-note">
      Everything students do is logged, anonymised: each company appears as a player number, never its name or code.
      Open a game's timeline from its row above.
      <template v-if="stats">
        <strong data-testid="log-stats">{{ formatCount(stats.events) }} event{{ stats.events === 1 ? "" : "s" }}</strong>
        from {{ formatCount(stats.companies) }} compan{{ stats.companies === 1 ? "y" : "ies" }} so far.
      </template>
    </p>

    <h3>Export</h3>
    <div class="log-filters">
      <label>
        <span>Code</span>
        <input v-model="code" inputmode="numeric" placeholder="All codes" autocomplete="off" :aria-invalid="!!codeProblem" />
      </label>
      <label>
        <span>Preset</span>
        <select v-model="preset">
          <option value="">All presets</option>
          <option v-for="p in presets" :key="p" :value="p">{{ p }}</option>
        </select>
      </label>
      <label>
        <span>Events</span>
        <select v-model="kind">
          <option value="">Game and UI</option>
          <option value="game">Game only</option>
          <option value="ui">UI only</option>
        </select>
      </label>
      <label>
        <span>From</span>
        <input v-model="from" type="date" />
      </label>
      <label>
        <span>To</span>
        <input v-model="to" type="date" :aria-invalid="!!rangeProblem" />
      </label>
    </div>
    <p v-if="codeProblem || rangeProblem" class="error" role="alert">{{ codeProblem || rangeProblem }}</p>
    <div class="log-actions">
      <template v-if="canExport">
        <a :href="csvUrl" class="button-link" download data-testid="export-csv">Download CSV</a>
        <a :href="jsonUrl" class="button-link ghost" download data-testid="export-json">Download JSON</a>
      </template>
      <span class="muted">One row per event, with the key numbers as columns and the details as JSON.</span>
    </div>

    <h3>Delete</h3>
    <p class="muted">
      Logs stay until you delete them. Deleting a game or a code deletes its logs too.
    </p>
    <p v-if="note" class="muted" role="status">{{ note }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="!confirming" class="log-actions">
      <button class="ghost danger" :disabled="busy || !codeValid" @click="confirming = 'code'">
        {{ codeValid ? `Delete logs for code ${formatCode(cleanCode)}` : "Delete a code's logs (enter it above)" }}
      </button>
      <button class="ghost danger" :disabled="busy || !stats?.events" @click="confirming = 'all'">Delete all logs</button>
    </div>
    <div
      v-else
      class="retire-confirm"
      role="group"
      :aria-label="confirming === 'all' ? 'Delete all logs?' : `Delete logs for code ${formatCode(cleanCode)}?`"
    >
      <p v-if="confirming === 'all'">
        Delete every logged event, for every game, permanently? The games stay. This can't be undone.
      </p>
      <p v-else>
        Delete the logged events of every game under code <strong class="mono">{{ formatCode(cleanCode) }}</strong>
        permanently? The games stay. This can't be undone.
      </p>
      <div class="retire-actions">
        <button class="danger-fill" :disabled="busy" @click="remove(confirming!)">Yes, delete them</button>
        <button class="ghost" :disabled="busy" @click="confirming = undefined">Cancel</button>
      </div>
    </div>
  </section>
</template>
