import { camera } from "./camera-stub.js";
import { type App, createApp, h } from "vue";

import "../../src/style.css";
import type { OpenedSnapshotLink } from "../../src/core/store.js";
import type { Phase } from "../../src/core/types.js";
import AddDevice from "../../src/ui/AddDevice.vue";
import Devices from "../../src/ui/Devices.vue";
import ImportLink from "../../src/ui/ImportLink.vue";
import Onboarding from "../../src/ui/Onboarding.vue";
import OpenedLink from "../../src/ui/OpenedLink.vue";
import { daemon, state, type ShownVault } from "./snapshot-store-stub.js";

/**
 * A page that mounts the first-run screen, where a vault is restored from
 * a link, the sheet where links are made, the row a link is imported
 * from, what the page says of a link it was opened with where a vault
 * is held, or the vault's devices, over the store's stub and a stand-in
 * camera; the test drives them through `window.snapshotFixture`.
 */
const SCREENS = { onboarding: Onboarding, "add-device": AddDevice, "import-link": ImportLink, "opened-link": OpenedLink, devices: Devices };

export type Screen = keyof typeof SCREENS;

/** what the page was opened with, the vault's phase and what it shows, and whether the daemon can list its links, import and ask the mediator, when the screen is mounted */
export interface Given {
  opened?: OpenedSnapshotLink;
  phase?: Phase;
  vault?: ShownVault;
  unlistable?: string;
  unmerged?: string;
  unasked?: string;
}

const fixture = {
  camera,
  daemon,
  state,
  mount(screen: Screen, given: Given) {
    app?.unmount();
    camera.tracks.length = 0;
    camera.codes.length = 0;
    daemon.calls.length = 0;
    daemon.links = [];
    daemon.unlistable = given.unlistable ?? null;
    daemon.unmerged = given.unmerged ?? null;
    daemon.held = null;
    daemon.told = null;
    daemon.relisted = null;
    daemon.unasked = given.unasked ?? null;
    state.pendingSnapshotLink = given.opened ?? null;
    state.snapshot = given.vault ?? null;
    state.vault.phase = given.phase ?? "onboarding";
    app = createApp({ render: () => h(SCREENS[screen]) });
    app.mount("#app");
  },
  open(opened: OpenedSnapshotLink) {
    state.pendingSnapshotLink = opened;
  },
  /** imports asked from now on answer only once `releaseImports` is called */
  holdImports() {
    daemon.held = new Promise((resolve) => (letImportsGo = resolve));
  },
  releaseImports() {
    daemon.held = null;
    letImportsGo();
  },
};

let letImportsGo = () => {};

declare global {
  interface Window {
    snapshotFixture: typeof fixture;
  }
}

let app: App | null = null;
window.snapshotFixture = fixture;
