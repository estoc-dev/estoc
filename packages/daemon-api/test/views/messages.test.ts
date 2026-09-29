import { describe, expect, it } from "vitest";

import { BASIC_MESSAGE, PROFILE, schemas } from "../../src/contract/index.js";
import { announcedName, basicMessage, profileMessage } from "../../src/views/index.js";

describe("the contents a view composes", () => {
  it("are a line of chat and an introduction, each passing the contract's schema", () => {
    expect(basicMessage("hello\nthere")).toEqual({ type: BASIC_MESSAGE, body: { content: "hello\nthere" } });
    expect(profileMessage("Ada")).toEqual({ type: PROFILE, body: { profile: { displayName: "Ada" } } });
    for (const content of [basicMessage("x"), profileMessage("Ada")]) expect(schemas.messageContent.parse(content)).toEqual(content);
  });

  it("read the name an introduction announces, and none from a body that names none", () => {
    expect(announcedName(profileMessage("Ada").body)).toBe("Ada");
    expect(announcedName({ profile: { displayName: "" } })).toBeNull();
    expect(announcedName({ profile: { displayName: 7 } })).toBeNull();
    expect(announcedName({ profile: [] })).toBeNull();
    expect(announcedName({ content: "hello" })).toBeNull();
  });
});
