import { describe, expect, it } from "vitest";

import type { AgentLines } from "@estoc/agent-core";
import { schemas } from "@estoc/daemon-api/contract";
import type { Did, MediationId } from "@estoc/vault";

import { linesOf } from "../src/lines.js";

const MEDIATION = "019b0000-0000-5000-8000-00000000000a" as MediationId;
const dids = (...names: string[]) => names.map((name) => `did:example:${name}` as Did);

describe("the lines a view is shown", () => {
  it("are the agent's three lists, each connection's recipients without the arrangement said again, and pass the schema", () => {
    const lines: AgentLines = {
      connections: [
        {
          mediationId: MEDIATION,
          unreachable: "socket closed",
          enrolled: null,
          recipients: { mediationId: MEDIATION, wanted: dids("a", "b"), added: dids("a"), refused: [{ did: dids("b")[0]!, because: "quota" }] },
          drained: { acked: 2, ended: "empty" },
          live: false,
        },
      ],
      waiting: [{ key: "k1", source: { kind: "pickup", mediationId: MEDIATION, deliveryId: "d1" }, reason: "no key", held: true }],
      discarded: [{ source: { kind: "direct" }, reason: "not for us" }],
    };
    const shown = linesOf(lines);
    expect(schemas.lines.parse(shown)).toEqual(shown);
    expect(shown).toEqual({
      connections: [
        {
          mediationId: MEDIATION,
          unreachable: "socket closed",
          recipients: { wanted: ["did:example:a", "did:example:b"], added: ["did:example:a"], refused: [{ did: "did:example:b", because: "quota" }] },
          drained: { acked: 2, ended: "empty" },
          live: false,
        },
      ],
      waiting: [{ key: "k1", source: { kind: "pickup", mediationId: MEDIATION, deliveryId: "d1" }, reason: "no key", held: true }],
      discarded: [{ source: { kind: "direct" }, reason: "not for us" }],
    });
  });

  it("are empty lists for an agent with nothing to say", () => {
    expect(linesOf({ connections: [], waiting: [], discarded: [] })).toEqual({ connections: [], waiting: [], discarded: [] });
  });
});
