import { describe, expect, expectTypeOf, test } from "vitest";

import type { EventReference, MessageId } from "@estoc/vault";

import { LiveAction, LiveInput } from "../src/index.js";

const MESSAGE = "019b0000-0000-7000-8000-000000000001" as MessageId;
const CID = "bafkreibamqxg7iv3qsdipkfn56owg2q4b5xkdpoz6s6ddoug7iugg75s64" as EventReference<"message.in">;

describe("the live authorities", () => {
  test("a host mints a manual action, which carries one invocation", () => {
    const manual = LiveAction.manual(MESSAGE);
    expect([manual.messageId, manual.kind, manual.spent]).toEqual([MESSAGE, "manual", false]);
    expect([manual.consume(), manual.consume(), manual.spent]).toEqual([true, false, true]);
  });

  test("the types refuse a host every other entry: the constructors, an initial action, and an input assembled from a recorded CID", () => {
    // @ts-expect-error the constructor is private
    const initial = new LiveAction(MESSAGE, "initial");
    // @ts-expect-error the constructor is private
    const input = new LiveInput(CID);
    expectTypeOf<{ cid: EventReference<"message.in"> }>().not.toMatchTypeOf<LiveInput>();
    expectTypeOf<{ messageId: MessageId; kind: "initial"; spent: boolean; consume: () => boolean }>().not.toMatchTypeOf<LiveAction>();
    expectTypeOf<LiveInput>().not.toHaveProperty("mint");
    expect([initial, input].map((minted) => minted.constructor.name)).toEqual(["LiveAction", "LiveInput"]);
  });
});
