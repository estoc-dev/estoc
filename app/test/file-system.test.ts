import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it, vi } from "vitest";

// the store reaches for the service worker's registration, which a build provides
vi.mock("../src/core/pwa.js", () => ({ isInstalled: () => false, setupPwa: () => undefined }));
const started = vi.hoisted(() => ({ sockets: [] as (string | null)[] }));
vi.mock("../src/daemon/client.js", () => ({
  daemonSocket: () => null,
  startDaemon: (socket: string | null) => {
    started.sockets.push(socket);
    const unheard = () => () => undefined;
    return { onConnection: unheard, onState: unheard, onLines: unheard, onLog: unheard };
  },
}));
// Vue's DOM runtime looks at the document once as it loads, and the store listens on it: loaded first, listened on after
await import("vue");
vi.stubGlobal("window", { addEventListener: () => undefined });
vi.stubGlobal("document", { addEventListener: () => undefined });
vi.stubGlobal("location", { search: "", pathname: "/", hash: "", href: "http://app.test/" });
// the app's screens ask how wide the window is as they load
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined }));

const REFUSAL = "Security error when calling GetDirectory";

async function bootedWith(getDirectory: () => Promise<unknown>) {
  vi.resetModules();
  started.sockets = [];
  vi.stubGlobal("navigator", { storage: { getDirectory } });
  const store = await import("../src/core/store.js");
  await store.boot();
  return store.state;
}

describe("a page with no daemon socket", () => {
  it("starts a worker of its own where the browser grants it a private file system", async () => {
    const state = await bootedWith(() => Promise.resolve({}));
    expect(started.sockets).toEqual([null]);
    expect(state.fileSystemRefused).toBeNull();
  });

  it("starts no worker and shows the refusal where the browser refuses it a private file system", async () => {
    const state = await bootedWith(() => Promise.reject(new DOMException(REFUSAL, "SecurityError")));
    expect(started.sockets).toEqual([]);
    expect(state.fileSystemRefused).toBe(REFUSAL);
    const { default: App } = await import("../src/App.vue");
    const html = await renderToString(createSSRApp(App));
    expect(html).toContain("data-file-system-refused");
    expect(html).toContain(REFUSAL);
  });
});
