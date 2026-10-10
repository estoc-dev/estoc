import { camera } from "./camera-stub.js";
import { type App, createApp, h } from "vue";

import "../../src/style.css";
import type { OpenedSnapshotLink } from "../../src/core/store.js";
import AddDevice from "../../src/ui/AddDevice.vue";
import Onboarding from "../../src/ui/Onboarding.vue";
import { daemon, state } from "./snapshot-store-stub.js";

/**
 * A page that mounts the first-run screen, where a vault is restored from
 * a link, or the sheet where links are made, over the store's stub and a
 * stand-in camera; the test drives both through `window.snapshotFixture`.
 */
export type Screen = "onboarding" | "add-device";

/** what the page was opened with, and whether the daemon can list its links, when the screen is mounted */
export interface Given {
  opened?: OpenedSnapshotLink;
  unlistable?: string;
}

const fixture = {
  camera,
  daemon,
  mount(screen: Screen, given: Given) {
    app?.unmount();
    camera.tracks.length = 0;
    camera.codes.length = 0;
    daemon.calls.length = 0;
    daemon.links = [];
    daemon.unlistable = given.unlistable ?? null;
    state.pendingSnapshotLink = given.opened ?? null;
    app = createApp({ render: () => h(screen === "onboarding" ? Onboarding : AddDevice) });
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
