import { afterEach, describe, expect, it, vi } from "vitest";

import { useUnconfirmed } from "../src/ui/unconfirmed.js";

const asked: string[] = [];
let answer = true;
vi.stubGlobal("confirm", (question: string) => {
  asked.push(question);
  return answer;
});

afterEach(() => {
  asked.length = 0;
  answer = true;
  useUnconfirmed().dismiss();
});

describe("a removal a screen offers", () => {
  it("asks first, and sends nothing when the person declines", async () => {
    const { unconfirmed, busy, remove } = useUnconfirmed();
    const removal = vi.fn(async () => undefined);
    answer = false;
    await remove("Remove it?", removal);
    expect(asked).toEqual(["Remove it?"]);
    expect(removal).not.toHaveBeenCalled();
    expect(unconfirmed.value).toBeNull();
    expect(busy.value).toBe(false);
  });

  it("shows why a removal did not happen, and lets the next attempt go out clean", async () => {
    const { unconfirmed, busy, remove } = useUnconfirmed();
    await remove("Remove it?", () => Promise.reject(new Error("that vault is gone already")));
    expect(unconfirmed.value).toEqual({ what: "The removal", because: "that vault is gone already" });
    expect(busy.value).toBe(false);
    await remove("Remove it?", async () => undefined);
    expect(unconfirmed.value).toBeNull();
    expect(asked).toHaveLength(2);
  });

  it("keeps the refusal until it is dismissed", async () => {
    const { unconfirmed, remove, dismiss } = useUnconfirmed();
    await remove("Remove it?", () => Promise.reject(new Error("that vault is gone already")));
    expect(unconfirmed.value?.because).toBe("that vault is gone already");
    dismiss();
    expect(unconfirmed.value).toBeNull();
  });

  it("takes one removal at a time: a second ask while one is under way is neither put nor sent", async () => {
    const { busy, remove } = useUnconfirmed();
    let finish!: () => void;
    const first = remove("Remove it?", () => new Promise<void>((resolve) => (finish = resolve)));
    expect(busy.value).toBe(true);
    const removal = vi.fn(async () => undefined);
    await remove("Remove it again?", removal);
    expect(asked).toEqual(["Remove it?"]);
    expect(removal).not.toHaveBeenCalled();
    finish();
    await first;
    expect(busy.value).toBe(false);
  });
});

describe("an operation whose failure outlives its screen", () => {
  it("is reported under its own name, with what it failed with, and asks nothing", async () => {
    const { unconfirmed, attempt } = useUnconfirmed();
    await attempt("Locking", () => Promise.reject(new Error("the connection to the daemon ended before it answered: whether this was done is unknown")));
    expect(asked).toEqual([]);
    expect(unconfirmed.value).toEqual({ what: "Locking", because: "the connection to the daemon ended before it answered: whether this was done is unknown" });
  });

  it("leaves nothing to report when it went through", async () => {
    const { unconfirmed, attempt } = useUnconfirmed();
    await attempt("Locking", async () => undefined);
    expect(unconfirmed.value).toBeNull();
  });
});
