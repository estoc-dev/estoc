<script setup lang="ts">
import { computed, ref } from "vue";
import type { TraceLevel } from "@estoc/agent-core";

import { mediatorLabel } from "../core/mediators.js";
import { exportedAt, forgetDevice, markExported } from "../core/seen.js";
import { chooseMediator, downloadBackup, forgetIdentity, lock, mergeBackup, reconnect, setTraceLevel, state } from "../core/store.js";
import Icon from "./Icon.vue";
import MediatorForm from "./MediatorForm.vue";
import { useStatus } from "./status.js";
import Topbar from "./Topbar.vue";
import { bytesOf, whenOf } from "./util.js";

/**
 * The person's own place: how they are reached, where their vault is
 * and how it leaves with them, what this device keeps for itself, and
 * the way out.
 */
const version = __APP_VERSION__;
const snapshot = computed(() => state.snapshot);
const { mediation, lamp, sentence } = useStatus();
const initial = computed(() => {
  const label = snapshot.value?.label ?? "";
  return label === "" ? "?" : [...label][0]!.toUpperCase();
});

const changingMediator = ref(false);

async function moveMediator(did: string) {
  await chooseMediator(did);
  changingMediator.value = false;
}

const storage = computed(() => {
  if (state.daemonAt !== null) return `a file on this machine, via estoc-daemon at ${new URL(state.daemonAt).host}`;
  if (state.persisted) return "in this browser, stored persistently";
  return "in this browser, best effort: keep a backup";
});

const exporting = ref(false);
async function exportBackup() {
  exporting.value = true;
  try {
    await downloadBackup();
    markExported();
  } finally {
    exporting.value = false;
  }
}

const lastExport = computed(() => {
  const at = exportedAt();
  return at === null ? "not yet" : `last: ${whenOf(at)}`;
});

const importInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const importNote = ref<string | null>(null);

async function importBackup(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file === undefined) return;
  importing.value = true;
  importNote.value = null;
  try {
    const merged = await mergeBackup(await bytesOf(file));
    importNote.value =
      merged.added === 0 && merged.objects === 0
        ? "Nothing new in that backup."
        : `Merged ${merged.added} new event${merged.added === 1 ? "" : "s"} and ${merged.objects} object${merged.objects === 1 ? "" : "s"}.`;
    if (merged.renewed) importNote.value += " That backup and this vault were copies of one another that both went on being written; this one now writes under a fresh ID of its own, its history unchanged.";
  } catch (err) {
    importNote.value = err instanceof Error ? err.message : String(err);
  } finally {
    importing.value = false;
    if (importInput.value !== null) importInput.value.value = "";
  }
}

const TRACE_NOTES: Record<TraceLevel, string> = {
  off: "nothing observed is kept",
  normal: "envelopes and frames, for a month",
  verbose: "the same and the bytes on the wire, for four months",
};
const traceBusy = ref(false);

async function chooseTraceLevel(event: Event) {
  traceBusy.value = true;
  try {
    await setTraceLevel((event.target as HTMLSelectElement).value as TraceLevel);
  } finally {
    traceBusy.value = false;
  }
}

function forget() {
  if (confirm("Delete this identity from this device? Keys, contacts and messages here are gone for good. Export a backup first if you want them back.")) {
    forgetDevice();
    void forgetIdentity();
  }
}
</script>

<template>
  <div class="screen" data-you-screen>
    <Topbar title="You" can-back />

    <div v-if="snapshot" class="screen-body page">
      <div style="display: flex; flex-direction: column; align-items: center; gap: 10px">
        <span class="avatar large you">{{ initial }}</span>
        <span style="font-size: 18px; font-weight: 600">{{ snapshot.label }}</span>
        <span class="note" :class="{ 'error-text': lamp === 'error' }" data-status-sentence>
          <span class="lamp" :class="lamp"></span>
          {{ sentence }}
          <button v-if="lamp === 'error' && state.away === null" class="link" type="button" data-reconnect @click="reconnect">try again</button>
        </span>
      </div>

      <div v-if="mediation === null" class="section" data-choose-mediator>
        <div class="eyebrow">Choose a mediator</div>
        <p class="note">A mediator holds sealed envelopes until you pick them up. Its address rides in every invitation you hand out.</p>
        <MediatorForm submit-label="Use this mediator" busy-label="Connecting…" :pick="chooseMediator" />
      </div>

      <div v-else class="section">
        <div class="eyebrow">Reached through</div>
        <div class="group">
          <button class="row" type="button" :title="mediation.mediatorDid ?? ''" data-mediator data-change-mediator @click="changingMediator = !changingMediator">
            <span class="row-main">
              <span>Mediator</span>
              <span class="row-sub">{{ mediatorLabel(mediation.mediatorDid ?? "") }}</span>
            </span>
            <span class="row-end">{{ changingMediator ? "keep it" : "change" }}</span>
          </button>
          <p v-for="fault in mediation.faults" :key="fault" class="error-text" style="padding: 0 16px 12px">{{ fault }}</p>
          <div v-if="changingMediator" style="padding: 4px 16px 16px">
            <MediatorForm submit-label="Use this mediator" busy-label="Connecting…" :current="mediation.mediatorDid" :pick="moveMediator" />
            <p class="note" style="margin-top: 10px">Addresses minted from here on go through the new mediator. The ones you have stay put until you use a fresh address in that conversation.</p>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="eyebrow">Your vault</div>
        <div class="group">
          <div class="row">
            <span class="row-main">
              <span>Where it is</span>
              <span class="row-sub">{{ storage }}</span>
            </span>
          </div>
          <button class="row" type="button" :disabled="exporting" data-export @click="exportBackup">
            <span class="row-main">
              <span>{{ exporting ? "Exporting…" : "Export a backup" }}</span>
              <span class="row-sub">one file holding everything here</span>
            </span>
            <span class="row-end">{{ lastExport }}</span>
          </button>
          <label class="row file-btn">
            <span class="row-main">
              <span>{{ importing ? "Merging…" : "Import a backup" }}</span>
              <span class="row-sub">what it holds is merged in</span>
            </span>
            <input ref="importInput" type="file" accept=".sqlite,application/vnd.sqlite3" :disabled="importing" data-import @change="importBackup" />
          </label>
          <p v-if="importNote" class="note" style="padding: 0 16px 12px" data-import-note>{{ importNote }}</p>
          <button v-if="state.install" class="row" type="button" data-install @click="state.install?.()">
            <span class="row-main">Install as an app</span>
            <Icon name="chevron" class="chevron" :size="20" />
          </button>
        </div>
        <p class="note">The passphrase seals the seed in a backup and nothing else: whoever has the file reads the messages.</p>
      </div>

      <div class="section">
        <div class="eyebrow">This device</div>
        <div class="group">
          <label class="row">
            <span class="row-main">
              <span>Trace</span>
              <span class="row-sub">{{ TRACE_NOTES[state.traceLevel] }}</span>
            </span>
            <select :value="state.traceLevel" :disabled="traceBusy" class="field" style="width: auto; min-height: 40px; padding: 6px 32px 6px 12px" data-trace-level @change="chooseTraceLevel">
              <option v-for="(_note, level) in TRACE_NOTES" :key="level" :value="level">{{ level }}</option>
            </select>
          </label>
          <button class="row" type="button" data-lock @click="lock">
            <span class="row-main">
              <span>Lock</span>
              <span class="row-sub">asks for the passphrase again</span>
            </span>
          </button>
        </div>
      </div>

      <div class="spacer"></div>

      <div class="section">
        <div class="group">
          <button class="row danger" type="button" data-forget @click="forget">
            <span class="row-main">Forget this identity</span>
          </button>
        </div>
        <p class="note">Gone from this device for good. A backup is the only way back.</p>
      </div>

      <p class="footer-note">Estoc {{ version }}<template v-if="state.offlineReady"> · ready to work offline</template></p>
    </div>
  </div>
</template>
