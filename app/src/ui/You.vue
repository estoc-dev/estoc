<script setup lang="ts">
import { computed, ref } from "vue";

import { chooseLook, look, type Look } from "../core/look.js";
import { mediatorLabel } from "../core/mediators.js";
import { exportedAt, forgetRemembered } from "../core/seen.js";
import { chooseMediator, downloadBackup, forgetIdentity, handedOutDid, heldNow, lock, mergeBackup, openIndex, publicDid, reconnect, setTraceLevel, state } from "../core/store.js";
import AddDevice from "./AddDevice.vue";
import Icon from "./Icon.vue";
import MediatorForm from "./MediatorForm.vue";
import { useStatus } from "./status.js";
import Topbar from "./Topbar.vue";
import type { TraceLevel } from "../core/types.js";
import { useUnconfirmed } from "./unconfirmed.js";
import { bytesOf, initialOfName, shortDid, whenOf } from "./util.js";

const version = __APP_VERSION__;
const snapshot = computed(() => openIndex()?.snapshot ?? null);
const { mediation, lamp, lost, sentence } = useStatus();
const initial = computed(() => initialOfName(snapshot.value?.label ?? null));

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const reconnectNote = ref<string | null>(null);

async function tryAgain() {
  reconnectNote.value = null;
  try {
    await reconnect();
  } catch (err) {
    reconnectNote.value = reasonOf(err);
  }
}

const changingMediator = ref(false);

async function moveMediator(did: string) {
  await chooseMediator(did);
  changingMediator.value = false;
}

const address = computed(() => handedOutDid(snapshot.value));
const copiedAddress = ref(false);
const readableAddress = ref<string | null>(null);
const addressNote = ref<string | null>(null);
const minting = ref(false);

async function copyAddress() {
  minting.value = true;
  addressNote.value = null;
  const held = heldNow();
  try {
    const did = address.value ?? (await publicDid());
    if (!held()) return;
    try {
      await navigator.clipboard.writeText(did);
      copiedAddress.value = true;
      setTimeout(() => (copiedAddress.value = false), 1500);
    } catch {
      readableAddress.value = did;
      addressNote.value = "It could not be copied from here: select the address below and copy it yourself.";
    }
  } catch (err) {
    addressNote.value = reasonOf(err);
  } finally {
    minting.value = false;
  }
}

const selectAll = (event: Event) => (event.target as HTMLInputElement).select();

const storage = computed(() => {
  if (state.daemonAt !== null) return `a file on this machine, via estoc-daemon at ${new URL(state.daemonAt).host}`;
  if (state.persisted) return "in this browser, stored persistently";
  return "in this browser, best effort: keep a backup";
});

const exporting = ref(false);
const exportNote = ref<string | null>(null);

async function exportBackup() {
  exporting.value = true;
  exportNote.value = null;
  try {
    await downloadBackup();
  } catch (err) {
    exportNote.value = reasonOf(err);
  } finally {
    exporting.value = false;
  }
}

const lastExport = computed(() => {
  const at = snapshot.value === null ? null : exportedAt(snapshot.value.anchor);
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
  const held = heldNow();
  try {
    const backup = await bytesOf(file);
    if (!held()) return;
    const merged = await mergeBackup(backup);
    importNote.value =
      merged.added === 0 && merged.objects === 0
        ? "Nothing new in that backup."
        : `Merged ${merged.added} new event${merged.added === 1 ? "" : "s"} and ${merged.objects} object${merged.objects === 1 ? "" : "s"}.`;
    if (merged.renewed) importNote.value += " That backup and this vault were copies of one another that both went on being written; this one now writes under a fresh ID of its own, its history unchanged.";
  } catch (err) {
    importNote.value = reasonOf(err);
  } finally {
    importing.value = false;
    if (importInput.value !== null) importInput.value.value = "";
  }
}

const addingDevice = ref(false);

const TRACE_NOTES: Record<TraceLevel, string> = {
  off: "nothing observed is kept",
  normal: "envelopes and frames, for a month",
  verbose: "the same and the bytes on the wire, for four months",
};
const traceBusy = ref(false);
const traceNote = ref<string | null>(null);

async function chooseTraceLevel(event: Event) {
  const select = event.target as HTMLSelectElement;
  traceBusy.value = true;
  traceNote.value = null;
  try {
    await setTraceLevel(select.value as TraceLevel);
  } catch (err) {
    traceNote.value = reasonOf(err);
    select.value = state.traceLevel;
  } finally {
    traceBusy.value = false;
  }
}

const LOOK_NOTES: Record<Look, string> = {
  system: "as the system has it",
  dark: "dark, whatever the system says",
  light: "light, whatever the system says",
};

const { busy, attempt, remove } = useUnconfirmed();

// Locking leaves this screen: what it fails with is shown wherever the person is by then.
const lockVault = () => attempt("Locking", lock);

function forget() {
  const hold = state.vault.hold;
  const shown = snapshot.value;
  return remove("Delete this identity from this device? Keys, contacts and messages here are gone for good. Export a backup first if you want them back.", async () => {
    await forgetIdentity(hold);
    if (shown !== null) forgetRemembered(shown);
  });
}
</script>

<template>
  <div class="screen" data-you-screen>
    <Topbar title="You" can-back />

    <div v-if="snapshot" class="screen-body page">
      <div style="display: flex; flex-direction: column; align-items: center; gap: 10px">
        <span class="avatar large">{{ initial }}</span>
        <span style="font-size: 18px; font-weight: 600">{{ snapshot.label }}</span>
        <span class="note" :class="{ 'error-text': lamp === 'error' }" data-status-sentence>
          <span class="lamp" :class="lamp"></span>
          {{ sentence }}
          <button v-if="(lamp === 'error' || lost) && state.away === null" class="link" type="button" data-reconnect @click="tryAgain">try again</button>
        </span>
        <span v-if="reconnectNote" class="note error-text" data-reconnect-note>{{ reconnectNote }}</span>
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
          <p v-for="fault in mediation.diagnostics" :key="fault" class="error-text" style="padding: 0 16px 12px">{{ fault }}</p>
          <div v-if="changingMediator" style="padding: 4px 16px 16px">
            <MediatorForm submit-label="Use this mediator" busy-label="Connecting…" :current="mediation.mediatorDid" :pick="moveMediator" />
            <p class="note" style="margin-top: 10px">Addresses minted from here on go through the new mediator. The ones you have stay put until you use a fresh address in that conversation.</p>
          </div>
          <button class="row" type="button" :disabled="minting" :title="address ?? ''" data-public-did @click="copyAddress">
            <span class="row-main">
              <span>Your DID</span>
              <span class="row-sub">{{ address === null ? "for anyone: minted when you first copy it" : shortDid(address) }}</span>
            </span>
            <span class="row-end">{{ copiedAddress ? "copied" : minting ? "minting…" : address === null ? "mint and copy" : "copy" }}</span>
          </button>
          <input v-if="readableAddress" class="field mono" readonly :value="readableAddress" aria-label="Your DID" data-public-did-text style="margin: 0 16px 12px; width: calc(100% - 32px)" @focus="selectAll" />
          <p v-if="addressNote" class="note" style="padding: 0 16px 12px" data-public-did-note>{{ addressNote }}</p>
        </div>
        <p class="note">A link is for whoever you hand it to, your DID for anyone who finds it: each one is answered from an address minted for them alone.</p>
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
          <p v-if="exportNote" class="note error-text" style="padding: 0 16px 12px" data-export-note>{{ exportNote }}</p>
          <label class="row file-btn">
            <span class="row-main">
              <span>{{ importing ? "Merging…" : "Import a backup" }}</span>
              <span class="row-sub">what it holds is merged in</span>
            </span>
            <input ref="importInput" type="file" accept=".sqlite,application/vnd.sqlite3" :disabled="importing" data-import @change="importBackup" />
          </label>
          <p v-if="importNote" class="note" style="padding: 0 16px 12px" data-import-note>{{ importNote }}</p>
          <button class="row" type="button" :disabled="mediation === null" data-add-device @click="addingDevice = true">
            <span class="row-main">
              <span>Add a device</span>
              <span class="row-sub">{{ mediation === null ? "once a mediator is chosen" : "a link that restores this vault there" }}</span>
            </span>
            <Icon name="chevron" class="chevron" :size="20" />
          </button>
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
          <p v-if="traceNote" class="note error-text" style="padding: 0 16px 12px" data-trace-note>{{ traceNote }}</p>
          <label class="row">
            <span class="row-main">
              <span>Look</span>
              <span class="row-sub">{{ LOOK_NOTES[look] }}</span>
            </span>
            <select :value="look" class="field" style="width: auto; min-height: 40px; padding: 6px 32px 6px 12px" data-look @change="chooseLook(($event.target as HTMLSelectElement).value as Look)">
              <option v-for="(_note, name) in LOOK_NOTES" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <button class="row" type="button" :disabled="busy" data-lock @click="lockVault">
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

      <AddDevice v-if="addingDevice" @close="addingDevice = false" />

      <p class="footer-note">Estoc {{ version }}<template v-if="state.offlineReady"> · ready to work offline</template></p>
    </div>
  </div>
</template>
