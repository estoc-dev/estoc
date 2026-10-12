import { camera } from "./camera-stub.js";
import { type App, createApp, h } from "vue";

import "../../src/style.css";
import type { OpenedSnapshotLink } from "../../src/core/store.js";
import type { Phase } from "../../src/core/types.js";
import AddDevice from "../../src/ui/AddDevice.vue";
import ImportLink from "../../src/ui/ImportLink.vue";
import Onboarding from "../../src/ui/Onboarding.vue";
import OpenedLink from "../../src/ui/OpenedLink.vue";
import { daemon, state } from "./snapshot-store-stub.js";

/**
 * A page that mounts the first-run screen, where a vault is restored from
 * a link, the sheet where links are made, the row a link is imported
 * from, or what the page says of a link it was opened with where a vault
 * is held, over the store's stub and a stand-in camera; the test drives
 * them through `window.snapshotFixture`.
 */
const SCREENS = { onboarding: Onboarding, "add-device": AddDevice, "import-link": ImportLink, "opened-link": OpenedLink };

export type Screen = keyof typeof SCREENS;

/** what the page was opened with, the vault's phase, and whether the daemon can list its links and import, when the screen is mounted */
export interface Given {
  opened?: OpenedSnapshotLink;
  phase?: Phase;
  unlistable?: string;
  unmerged?: string;
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
    state.pendingSnapshotLink = given.opened ?? null;
    state.vault.phase = given.phase ?? "onboarding";
    app = createApp({ render: () => h(SCREENS[screen]) });
    app.mount("#app");
  },
  open(opened: OpenedSnapshotLink) {
    state.pendingSnapshotLink = opened;
  },
};

declare global {
  interface Window {
    snapshotFixture: typeof fixture;
  }
}

let app: App | null = null;
window.snapshotFixture = fixture;
