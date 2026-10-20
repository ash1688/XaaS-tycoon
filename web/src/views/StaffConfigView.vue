<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { CONFIG_GROUPS, type ConfigErrors, type ConfigField, type ConfigOverrides } from "@xaas/sim";
import type { ConfigErrorView, ConfigView } from "@xaas/server/api-types";
import { api, RequestError } from "../api";
import AppModal from "../components/AppModal.vue";

// The teacher's config page: the game's numbers, grouped, each with its default, range and a reset. Saving changes
// what games started from then on use; games already started keep the numbers they began with.
const config = ref<ConfigView>();
// What's in each box, by path. Starts as the saved value. v-model on a number box gives a number, or "" when empty.
const draft = reactive<Record<string, string | number>>({});
const fieldErrors = ref<ConfigErrors>({});
const error = ref("");
const saved = ref("");
const busy = ref(false);
const signedOut = ref(false);
const search = ref("");
const confirmingReset = ref(false);
// Groups the teacher has opened. While searching, every group with a match is open.
const openGroups = reactive(new Set<string>());

const fields = computed(() => config.value?.fields ?? []);
const savedValue = (f: ConfigField) => config.value?.overrides[f.path] ?? f.default;

const format = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 4 });
const parse = (value: string | number | undefined) =>
  typeof value === "number" ? value : !value?.trim() ? Number.NaN : Number(value);
const changedFromDefault = (f: ConfigField) => parse(draft[f.path]) !== f.default;
const unsaved = (f: ConfigField) => parse(draft[f.path]) !== savedValue(f);

const unsavedCount = computed(() => fields.value.filter(unsaved).length);
const overrideCount = computed(() => Object.keys(config.value?.overrides ?? {}).length);

const matches = (f: ConfigField, q: string) =>
  !q || [f.label, f.help, f.section, f.group, f.path].some((s) => s.toLowerCase().includes(q));

// Each group's fields that match the search, split by section in config order.
const groups = computed(() => {
  const q = search.value.trim().toLowerCase();
  return CONFIG_GROUPS.map((name) => {
    const inGroup = fields.value.filter((f) => f.group === name);
    const shown = inGroup.filter((f) => matches(f, q));
    // In order of each section's first field: game-wide numbers, then per model, product and so on.
    const sections = new Map<string, ConfigField[]>();
    for (const f of shown) sections.set(f.section, [...(sections.get(f.section) ?? []), f]);
    return {
      name,
      total: inGroup.length,
      changed: inGroup.filter(changedFromDefault).length,
      errors: inGroup.filter((f) => fieldErrors.value[f.path]).length,
      sections: [...sections].map(([section, list]) => ({ name: section, fields: list })),
      shown: shown.length,
    };
  }).filter((g) => g.total > 0);
});
const searching = computed(() => search.value.trim() !== "");
const isOpen = (group: string) => searching.value || openGroups.has(group);

function toggle(group: string, e: Event) {
  if (searching.value) return;
  const open = (e.target as HTMLDetailsElement).open;
  if (open) openGroups.add(group);
  else openGroups.delete(group);
}

function fill(view: ConfigView) {
  config.value = view;
  for (const f of view.fields) draft[f.path] = String(view.overrides[f.path] ?? f.default);
}

async function run(task: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  saved.value = "";
  try {
    await task();
  } catch (e) {
    if (e instanceof RequestError && e.status === 401) signedOut.value = true;
    else error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

onMounted(() => run(async () => fill(await api.teacherConfig())));

function resetField(f: ConfigField) {
  draft[f.path] = String(f.default);
  delete fieldErrors.value[f.path];
}

function undoChanges() {
  if (config.value) fill(config.value);
  fieldErrors.value = {};
}

async function save() {
  const errors: ConfigErrors = {};
  const overrides: ConfigOverrides = {};
  for (const f of fields.value) {
    const value = parse(draft[f.path]);
    if (Number.isNaN(value)) errors[f.path] = "Enter a number.";
    else if (value !== f.default) overrides[f.path] = value;
  }
  fieldErrors.value = errors;
  if (Object.keys(errors).length) {
    error.value = "Some settings need fixing before saving.";
    return openErrors();
  }
  await run(async () => {
    try {
      fill(await api.saveConfig(overrides));
      fieldErrors.value = {};
      saved.value = "Saved. Games started from now on use these numbers.";
    } catch (e) {
      if (e instanceof RequestError && e.code === "invalid_config") {
        fieldErrors.value = (e.body as Partial<ConfigErrorView>).fields ?? {};
        openErrors();
      }
      throw e;
    }
  });
}

async function resetAll() {
  await run(async () => {
    fill(await api.resetConfig());
    fieldErrors.value = {};
    confirmingReset.value = false;
    saved.value = "Every number is back to its default for games started from now on.";
  });
}

// Opens the groups with an error, so the teacher can see what to fix.
function openErrors() {
  for (const f of fields.value) if (fieldErrors.value[f.path]) openGroups.add(f.group);
}

const inputId = (f: ConfigField) => `cfg-${f.path.replace(/\./g, "-")}`;
</script>

<template>
  <p class="back"><RouterLink to="/staff">← Staff dashboard</RouterLink></p>
  <section v-if="signedOut" class="card narrow">
    <p>Your staff session has ended. <RouterLink to="/staff">Sign in again</RouterLink> to edit the config.</p>
  </section>
  <p v-else-if="!config && error" class="error" role="alert">{{ error }}</p>
  <template v-else-if="config">
    <section class="card config-intro">
      <h1>Game config</h1>
      <p class="config-note" data-testid="config-note">
        <strong>Changes apply to games started from now on.</strong> Games already started keep the numbers they began
        with.
      </p>
      <p class="muted">
        Each number shows its default and the range it can take. Reset one to go back to its default, or reset all.
        <template v-if="overrideCount">
          {{ overrideCount }} number{{ overrideCount === 1 ? " differs" : "s differ" }} from the defaults.
        </template>
        <template v-else>New games use the defaults.</template>
      </p>
      <div class="config-tools">
        <label for="config-search" class="visually-hidden">Search settings</label>
        <input id="config-search" v-model="search" type="search" placeholder="Search settings, e.g. day rate" />
        <button class="ghost danger" :disabled="busy || !overrideCount" @click="confirmingReset = true">
          Reset all
        </button>
      </div>
    </section>

    <p v-if="searching && !groups.some((g) => g.shown)" class="muted">No settings match “{{ search }}”.</p>

    <template v-for="g in groups" :key="g.name">
      <details
        v-if="g.shown"
        class="card config-group"
        :open="isOpen(g.name)"
        :data-group="g.name"
        @toggle="toggle(g.name, $event)"
      >
        <summary>
          <span class="config-group-name">{{ g.name }}</span>
          <span class="muted">
            {{ searching ? `${g.shown} of ${g.total}` : g.total }} settings<template v-if="g.changed"
              >, {{ g.changed }} changed</template
            >
          </span>
          <span v-if="g.errors" class="warn-badge">{{ g.errors }} to fix</span>
        </summary>

        <div v-for="s in g.sections" :key="s.name" class="config-section">
          <h3 v-if="s.name">{{ s.name }}</h3>
          <div
            v-for="f in s.fields"
            :key="f.path"
            class="config-field"
            :class="{ changed: changedFromDefault(f), invalid: fieldErrors[f.path] }"
            :data-path="f.path"
          >
            <div class="config-field-text">
              <label :for="inputId(f)">{{ f.label }}</label>
              <p class="muted">{{ f.help }}</p>
              <p class="config-meta muted">
                Default {{ format(f.default) }} · {{ format(f.min) }} to {{ format(f.max) }}
              </p>
            </div>
            <div class="config-field-input">
              <input
                :id="inputId(f)"
                v-model="draft[f.path]"
                type="number"
                inputmode="decimal"
                :min="f.min"
                :max="f.max"
                :step="f.step"
                :aria-invalid="!!fieldErrors[f.path]"
                :aria-describedby="fieldErrors[f.path] ? `${inputId(f)}-error` : undefined"
                @input="delete fieldErrors[f.path]"
              />
              <button
                class="ghost small"
                type="button"
                :disabled="!changedFromDefault(f)"
                :aria-label="`Reset ${s.name ? `${s.name} ` : ''}${f.label} to its default`"
                @click="resetField(f)"
              >
                Reset
              </button>
            </div>
            <p v-if="fieldErrors[f.path]" :id="`${inputId(f)}-error`" class="error config-field-error">
              {{ fieldErrors[f.path] }}
            </p>
          </div>
        </div>
      </details>
    </template>

    <div class="config-bar" role="region" aria-label="Save changes">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-else-if="saved" class="pos" role="status">{{ saved }}</p>
      <p v-else class="muted">
        {{ unsavedCount ? `${unsavedCount} unsaved change${unsavedCount === 1 ? "" : "s"}` : "No unsaved changes" }}
      </p>
      <div class="config-bar-actions">
        <button class="ghost" :disabled="busy || !unsavedCount" @click="undoChanges">Undo changes</button>
        <button :disabled="busy || !unsavedCount" @click="save">Save</button>
      </div>
    </div>

    <AppModal :open="confirmingReset" title="Reset every number?" @close="confirmingReset = false">
      <p>
        Every number goes back to its default for games started from now on. Games already started keep their numbers.
      </p>
      <div class="retire-actions">
        <button class="danger-fill" :disabled="busy" @click="resetAll">Yes, reset all</button>
        <button class="ghost" :disabled="busy" @click="confirmingReset = false">Cancel</button>
      </div>
    </AppModal>
  </template>
</template>
