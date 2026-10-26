<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { CONFIG_GROUPS, type ConfigErrors, type ConfigField, type ConfigOverrides } from "@xaas/sim";
import type { ConfigErrorView, PresetsView, PresetSummaryView, PresetView } from "@xaas/server/api-types";
import { api, RequestError } from "../api";
import AppModal from "../components/AppModal.vue";

// The teacher's config page: named presets of the game's numbers, and an editor for one of them. The numbers are
// grouped, each with its default, range and a reset. The active preset is what games started from then on use; games
// already started keep the numbers they began with. Default is built in and read-only, but can be saved as a copy.
const presets = ref<PresetsView>();
// The preset open in the editor.
const config = ref<PresetView>();
// What's in each box, by path. Starts as the saved value. v-model on a number box gives a number, or "" when empty.
const draft = reactive<Record<string, string | number>>({});
const fieldErrors = ref<ConfigErrors>({});
const error = ref("");
const saved = ref("");
const busy = ref(false);
const signedOut = ref(false);
const search = ref("");
// Groups the teacher has opened. While searching, every group with a match is open.
const openGroups = reactive(new Set<string>());

// The dialog showing, if any: each asks before something the teacher might not mean.
type Dialog =
  | { kind: "saveAs" }
  | { kind: "rename"; preset: PresetSummaryView }
  | { kind: "activate"; preset: PresetSummaryView }
  | { kind: "delete"; preset: PresetSummaryView }
  | { kind: "discard"; preset: PresetSummaryView }
  | { kind: "resetAll" };
const dialog = ref<Dialog>();
// The name typed in the save-as or rename dialog, and what's wrong with it.
const nameDraft = ref("");
const nameError = ref("");

const readOnly = computed(() => !!config.value?.builtIn);
const fields = computed(() => config.value?.fields ?? []);
const savedValue = (f: ConfigField) => config.value?.overrides[f.path] ?? f.default;
const activePreset = computed(() => presets.value?.presets.find((p) => p.active));

// One formatter for every field's range: toLocaleString with options builds a new one per call, and the page re-renders
// every field on each keystroke.
const numberFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 });
const format = (n: number) => numberFormat.format(n);
const parse = (value: string | number | undefined) =>
  typeof value === "number" ? value : !value?.trim() ? Number.NaN : Number(value);
const changedFromDefault = (f: ConfigField) => parse(draft[f.path]) !== f.default;
const unsaved = (f: ConfigField) => parse(draft[f.path]) !== savedValue(f);

const unsavedCount = computed(() => fields.value.filter(unsaved).length);
const overrideCount = computed(() => Object.keys(config.value?.overrides ?? {}).length);
const changedLabel = (n: number) => (n ? `${n} number${n === 1 ? "" : "s"} changed` : "The defaults");

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

function fill(view: PresetView) {
  config.value = view;
  for (const f of view.fields) draft[f.path] = String(view.values[f.path] ?? f.default);
  fieldErrors.value = {};
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

// Opens the active preset: the one new games use, so most likely the one to change.
onMounted(() =>
  run(async () => {
    presets.value = await api.presets();
    fill(await api.preset(presets.value.active));
  }),
);

// Opening another preset drops any unsaved changes, so it asks first.
function open(preset: PresetSummaryView) {
  if (preset.id === config.value?.id) return;
  if (unsavedCount.value) dialog.value = { kind: "discard", preset };
  else openNow(preset);
}

async function openNow(preset: PresetSummaryView) {
  dialog.value = undefined;
  await run(async () => fill(await api.preset(preset.id)));
}

function resetField(f: ConfigField) {
  draft[f.path] = String(f.default);
  delete fieldErrors.value[f.path];
}

function undoChanges() {
  if (config.value) fill(config.value);
}

/** The numbers in the boxes that differ from the defaults, or undefined if a box isn't a number. */
function draftOverrides(): ConfigOverrides | undefined {
  const errors: ConfigErrors = {};
  const overrides: ConfigOverrides = {};
  for (const f of fields.value) {
    const value = parse(draft[f.path]);
    if (Number.isNaN(value)) errors[f.path] = "Enter a number.";
    else if (value !== f.default) overrides[f.path] = value;
  }
  fieldErrors.value = errors;
  if (!Object.keys(errors).length) return overrides;
  error.value = "Some settings need fixing before saving.";
  openErrors();
  return undefined;
}

/** Runs a save, putting the server's per-field errors by their fields. */
async function saving(task: () => Promise<void>) {
  await run(async () => {
    try {
      await task();
    } catch (e) {
      if (e instanceof RequestError && e.code === "invalid_config") {
        fieldErrors.value = (e.body as Partial<ConfigErrorView>).fields ?? {};
        openErrors();
      }
      throw e;
    }
  });
}

async function save() {
  const preset = config.value;
  const overrides = draftOverrides();
  if (!preset || !overrides) return;
  await saving(async () => {
    fill(await api.updatePreset(preset.id, { overrides }));
    presets.value = await api.presets();
    saved.value = preset.active
      ? "Saved. Games started from now on use these numbers."
      : `Saved. Make “${preset.name}” active for new games to use it.`;
  });
}

async function resetAll() {
  const preset = config.value;
  if (!preset) return;
  await run(async () => {
    fill(await api.updatePreset(preset.id, { overrides: {} }));
    presets.value = await api.presets();
    dialog.value = undefined;
    saved.value = `Every number in “${preset.name}” is back to its default.`;
  });
}

function startSaveAs() {
  nameDraft.value = config.value?.builtIn ? "" : `${config.value?.name} copy`.slice(0, presets.value?.maxNameLength);
  nameError.value = "";
  dialog.value = { kind: "saveAs" };
}

function startRename(preset: PresetSummaryView) {
  nameDraft.value = preset.name;
  nameError.value = "";
  dialog.value = { kind: "rename", preset };
}

/** Runs a save-as or rename, showing a bad or taken name in the dialog rather than on the page. */
async function naming(task: () => Promise<void>) {
  nameError.value = "";
  await run(async () => {
    try {
      await task();
      dialog.value = undefined;
    } catch (e) {
      if (e instanceof RequestError && (e.code === "invalid_name" || e.code === "name_taken")) {
        nameError.value = e.message;
      } else {
        dialog.value = undefined;
        throw e;
      }
    }
  });
}

// Saves the numbers in the boxes, unsaved changes included, as a new preset, and opens it. The preset they came from
// keeps its saved numbers.
async function saveAs() {
  const overrides = draftOverrides();
  if (!overrides) {
    dialog.value = undefined;
    return;
  }
  await naming(async () => {
    try {
      fill(await api.createPreset({ name: nameDraft.value, overrides }));
    } catch (e) {
      if (e instanceof RequestError && e.code === "invalid_config") {
        fieldErrors.value = (e.body as Partial<ConfigErrorView>).fields ?? {};
        openErrors();
      }
      throw e;
    }
    presets.value = await api.presets();
    saved.value = `Saved as “${config.value!.name}”. Make it active for new games to use it.`;
  });
}

async function rename(preset: PresetSummaryView) {
  await naming(async () => {
    const view = await api.updatePreset(preset.id, { name: nameDraft.value });
    // Only the name changed, so any unsaved numbers in the editor stay.
    if (config.value?.id === view.id) config.value = { ...config.value, name: view.name };
    presets.value = await api.presets();
    saved.value = `Renamed to “${view.name}”.`;
  });
}

async function activate(preset: PresetSummaryView) {
  await run(async () => {
    presets.value = await api.activatePreset(preset.id);
    if (config.value) config.value = { ...config.value, active: config.value.id === preset.id };
    dialog.value = undefined;
    saved.value = `New games will use “${preset.name}”.`;
  });
}

async function remove(preset: PresetSummaryView) {
  await run(async () => {
    presets.value = await api.deletePreset(preset.id);
    dialog.value = undefined;
    if (config.value?.id === preset.id) fill(await api.preset(presets.value.active));
    saved.value = `Deleted “${preset.name}”.`;
  });
}

// Opens the groups with an error, so the teacher can see what to fix.
function openErrors() {
  for (const f of fields.value) if (fieldErrors.value[f.path]) openGroups.add(f.group);
}

const dialogTitle = computed(() => {
  const d = dialog.value;
  if (!d) return "";
  switch (d.kind) {
    case "saveAs":
      return "Save as a new preset";
    case "rename":
      return `Rename “${d.preset.name}”`;
    case "activate":
      return `Make “${d.preset.name}” active?`;
    case "delete":
      return `Delete “${d.preset.name}”?`;
    case "discard":
      return "Discard unsaved changes?";
    case "resetAll":
      return "Reset every number?";
  }
  return "";
});

const inputId = (f: ConfigField) => `cfg-${f.path.replace(/\./g, "-")}`;
</script>

<template>
  <p class="back"><RouterLink to="/staff">← Staff dashboard</RouterLink></p>
  <section v-if="signedOut" class="card narrow">
    <p>Your staff session has ended. <RouterLink to="/staff">Sign in again</RouterLink> to edit the config.</p>
  </section>
  <p v-else-if="!config && error" class="error" role="alert">{{ error }}</p>
  <template v-else-if="config && presets">
    <section class="card config-intro">
      <h1>Game config</h1>
      <p class="config-note" data-testid="config-note">
        <strong>Changes apply to games started from now on.</strong> Games already started keep the numbers they began
        with.
      </p>
      <p class="muted">
        Keep setups as presets, such as “Easy mode” or “Lesson 3”. New games use the
        <strong>active</strong> preset<template v-if="activePreset">, now “{{ activePreset.name }}”</template>. Default
        is built in and can't be changed, but you can save it as a copy to edit.
      </p>

      <h2 class="config-presets-heading">Presets</h2>
      <ul class="preset-list" aria-label="Presets">
        <li
          v-for="p in presets.presets"
          :key="p.id"
          class="preset-item"
          :class="{ selected: p.id === config.id }"
          :data-preset="p.name"
        >
          <div class="preset-name">
            <button
              class="link-button"
              :aria-current="p.id === config.id ? 'true' : undefined"
              :aria-label="`${p.builtIn ? 'View' : 'Edit'} ${p.name}`"
              @click="open(p)"
            >
              {{ p.name }}
            </button>
            <span v-if="p.active" class="badge done-badge" data-testid="active-badge">Active</span>
            <span v-if="p.builtIn" class="badge retired-badge">Built in</span>
            <small class="muted">{{ changedLabel(p.changed) }}</small>
          </div>
          <div class="preset-actions">
            <button
              v-if="!p.active"
              class="ghost small"
              :disabled="busy"
              :aria-label="`Make ${p.name} active`"
              @click="dialog = { kind: 'activate', preset: p }"
            >
              Make active
            </button>
            <template v-if="!p.builtIn">
              <button class="ghost small" :disabled="busy" :aria-label="`Rename ${p.name}`" @click="startRename(p)">
                Rename
              </button>
              <button
                class="ghost small danger"
                :disabled="busy || p.active"
                :title="p.active ? 'Make another preset active before deleting this one.' : undefined"
                :aria-label="`Delete ${p.name}`"
                @click="dialog = { kind: 'delete', preset: p }"
              >
                Delete
              </button>
            </template>
          </div>
        </li>
      </ul>
    </section>

    <section class="card config-editing" aria-labelledby="editing-heading">
      <h2 id="editing-heading" data-testid="editing">
        {{ readOnly ? "Viewing" : "Editing" }} “{{ config.name }}”
        <span v-if="config.active" class="badge done-badge">Active</span>
      </h2>
      <p class="muted">
        <template v-if="readOnly">
          The built-in numbers, read-only. <strong>Save as</strong> a new preset to change them.
        </template>
        <template v-else>Each number shows its default and the range it can take. Reset one, or reset all.</template>
        {{ " " }}
        <template v-if="overrideCount">
          {{ overrideCount }} number{{ overrideCount === 1 ? " differs" : "s differ" }} from the defaults.
        </template>
      </p>
      <div class="config-tools">
        <label for="config-search" class="visually-hidden">Search settings</label>
        <input id="config-search" v-model="search" type="search" placeholder="Search settings, e.g. day rate" />
        <button v-if="!readOnly" class="ghost danger" :disabled="busy || !overrideCount" @click="dialog = { kind: 'resetAll' }">
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
              <p v-if="f.kind === 'toggle'" class="config-meta muted">Default {{ f.default ? "on" : "off" }}</p>
              <p v-else class="config-meta muted">
                Default {{ format(f.default) }} · {{ format(f.min) }} to {{ format(f.max) }}
              </p>
            </div>
            <div class="config-field-input">
              <!-- A toggle is stored as 1 or 0 like any other number, but drawn as a checkbox. -->
              <input
                v-if="f.kind === 'toggle'"
                :id="inputId(f)"
                type="checkbox"
                :checked="draft[f.path] === '1'"
                :disabled="readOnly"
                :aria-invalid="!!fieldErrors[f.path]"
                :aria-describedby="fieldErrors[f.path] ? `${inputId(f)}-error` : undefined"
                @change="
                  draft[f.path] = ($event.target as HTMLInputElement).checked ? '1' : '0';
                  delete fieldErrors[f.path];
                "
              />
              <input
                v-else
                :id="inputId(f)"
                v-model="draft[f.path]"
                type="number"
                inputmode="decimal"
                :min="f.min"
                :max="f.max"
                :step="f.step"
                :readonly="readOnly"
                :aria-invalid="!!fieldErrors[f.path]"
                :aria-describedby="fieldErrors[f.path] ? `${inputId(f)}-error` : undefined"
                @input="delete fieldErrors[f.path]"
              />
              <button
                v-if="!readOnly"
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
      <p v-else-if="readOnly" class="muted">Default is read-only.</p>
      <p v-else class="muted">
        {{ unsavedCount ? `${unsavedCount} unsaved change${unsavedCount === 1 ? "" : "s"}` : "No unsaved changes" }}
      </p>
      <div class="config-bar-actions">
        <template v-if="!readOnly">
          <button class="ghost" :disabled="busy || !unsavedCount" @click="undoChanges">Undo changes</button>
          <button :disabled="busy || !unsavedCount" @click="save">Save</button>
        </template>
        <button :class="{ ghost: !readOnly }" :disabled="busy" @click="startSaveAs">Save as…</button>
      </div>
    </div>

    <AppModal small :open="!!dialog" :title="dialogTitle" @close="dialog = undefined">
      <form
        v-if="dialog?.kind === 'saveAs' || dialog?.kind === 'rename'"
        class="preset-name-form"
        @submit.prevent="dialog.kind === 'saveAs' ? saveAs() : rename(dialog.preset)"
      >
        <p v-if="dialog.kind === 'saveAs'">
          Saves the numbers shown<template v-if="unsavedCount">, unsaved changes included,</template> as a new preset.
          It isn't active until you make it so.
        </p>
        <label for="preset-name">Preset name</label>
        <input
          id="preset-name"
          v-model="nameDraft"
          type="text"
          :maxlength="presets.maxNameLength"
          autocomplete="off"
          :aria-invalid="!!nameError"
          :aria-describedby="nameError ? 'preset-name-error' : undefined"
        />
        <p v-if="nameError" id="preset-name-error" class="error">{{ nameError }}</p>
        <div class="retire-actions">
          <button type="submit" :disabled="busy || !nameDraft.trim()">
            {{ dialog.kind === "saveAs" ? "Save preset" : "Rename" }}
          </button>
          <button type="button" class="ghost" :disabled="busy" @click="dialog = undefined">Cancel</button>
        </div>
      </form>
      <template v-else-if="dialog?.kind === 'activate'">
        <p>
          New games will use <strong>“{{ dialog.preset.name }}”</strong>. Games already started keep the numbers they
          began with.
        </p>
        <div class="retire-actions">
          <button :disabled="busy" @click="activate(dialog.preset)">Yes, make it active</button>
          <button class="ghost" :disabled="busy" @click="dialog = undefined">Cancel</button>
        </div>
      </template>
      <template v-else-if="dialog?.kind === 'delete'">
        <p>
          Delete the preset <strong>“{{ dialog.preset.name }}”</strong>? Games started on it keep their numbers and its
          name. This can't be undone.
        </p>
        <div class="retire-actions">
          <button class="danger-fill" :disabled="busy" @click="remove(dialog.preset)">Yes, delete it</button>
          <button class="ghost" :disabled="busy" @click="dialog = undefined">Cancel</button>
        </div>
      </template>
      <template v-else-if="dialog?.kind === 'discard'">
        <p>
          “{{ config.name }}” has {{ unsavedCount }} unsaved change{{ unsavedCount === 1 ? "" : "s" }}. Opening
          “{{ dialog.preset.name }}” loses them.
        </p>
        <div class="retire-actions">
          <button class="danger-fill" :disabled="busy" @click="openNow(dialog.preset)">Discard and open</button>
          <button class="ghost" :disabled="busy" @click="dialog = undefined">Keep editing</button>
        </div>
      </template>
      <template v-else-if="dialog?.kind === 'resetAll'">
        <p>
          Every number in “{{ config.name }}” goes back to its default.
          <template v-if="config.active">Games started from now on use the defaults.</template> Games already started
          keep their numbers.
        </p>
        <div class="retire-actions">
          <button class="danger-fill" :disabled="busy" @click="resetAll">Yes, reset all</button>
          <button class="ghost" :disabled="busy" @click="dialog = undefined">Cancel</button>
        </div>
      </template>
    </AppModal>
  </template>
</template>
