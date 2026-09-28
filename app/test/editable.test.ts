import { nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";

import { editableFrom } from "../src/ui/editable.js";

describe("a field over a value the vault holds", () => {
  it("shows the value, and follows it while nothing was typed", async () => {
    const source = ref("Bob");
    const field = editableFrom(source);
    expect(field.value).toBe("Bob");
    source.value = "Robert";
    await nextTick();
    expect(field.value).toBe("Robert");
  });

  it("keeps what was typed when the vault repeats or changes its value", async () => {
    const source = ref("Bob");
    const field = editableFrom(source);
    field.value = "Robert in progress";
    source.value = "Bob";
    await nextTick();
    expect(field.value).toBe("Robert in progress");
    source.value = "Bobby";
    await nextTick();
    expect(field.value).toBe("Robert in progress");
  });

  it("follows again once what was typed is what the vault holds", async () => {
    const source = ref("Bob");
    const field = editableFrom(source);
    field.value = "Robert";
    source.value = "Robert";
    await nextTick();
    source.value = "Rob";
    await nextTick();
    expect(field.value).toBe("Rob");
  });
});
