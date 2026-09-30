import { ref, watchEffect } from "vue";

/**
 * Which look the app wears on this device: the system's, or dark or
 * light regardless. Like what this device remembers of the person's
 * looking, it lives in the browser and travels in no backup. The
 * index page reads the same key before first paint, so that a chosen
 * look never flashes the other one on the way in.
 */
export type Look = "system" | "dark" | "light";

const KEY = "estoc.look";
const LOOKS: readonly Look[] = ["system", "dark", "light"];

const SURFACE = { dark: "#202b30", light: "#eef3f5" };

function stored(): Look {
  try {
    const value = localStorage.getItem(KEY);
    return LOOKS.includes(value as Look) ? (value as Look) : "system";
  } catch {
    return "system";
  }
}

export const look = ref<Look>(stored());

export function chooseLook(next: Look): void {
  look.value = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // storage that will not take it: the look holds for this session
  }
}

/** Dresses the page in the chosen look, and keeps it dressed as the choice or the system changes. */
export function wearLook(): void {
  const systemLight = matchMedia("(prefers-color-scheme: light)");
  const systemIsLight = ref(systemLight.matches);
  systemLight.addEventListener("change", (event) => (systemIsLight.value = event.matches));
  watchEffect(() => {
    const root = document.documentElement;
    if (look.value === "system") delete root.dataset.theme;
    else root.dataset.theme = look.value;
    const worn = look.value === "system" ? (systemIsLight.value ? "light" : "dark") : look.value;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", SURFACE[worn]);
  });
}
