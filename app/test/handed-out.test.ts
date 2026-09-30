import { parseInvitation } from "@estoc/daemon-api/views";
import { describe, expect, it, vi } from "vitest";

// the store reaches for the service worker's registration, which a build provides
vi.mock("../src/core/pwa.js", () => ({ isInstalled: () => false, setupPwa: () => undefined }));

import { handedOutDid, invitationLink, state } from "../src/core/store.js";
import type { Snapshot } from "../src/core/types.js";

type LocalDid = Snapshot["dids"][number];
type InvitationRecord = Snapshot["invitations"][number];

const did = (n: number, over: Partial<LocalDid> = {}): LocalDid => ({
  didId: `019b0000-0000-7000-8000-0000000000d${n}` as LocalDid["didId"],
  did: `did:peer:4zD${n}`,
  longFormDid: `did:peer:4zD${n}:zLong${n}`,
  live: true,
  retired: null,
  disclosures: [],
  diagnostics: [],
  ...over,
});

const snapshot = (dids: LocalDid[]) => ({ dids }) as Snapshot;

describe("the DID handed out, read from a snapshot", () => {
  it("is the live one disclosed directly, in its long form", () => {
    expect(handedOutDid(snapshot([did(1), did(2, { disclosures: [{ as: "oob" }] }), did(3, { disclosures: [{ as: "direct" }] })]))).toBe("did:peer:4zD3:zLong3");
  });

  it("is null before one is minted, and null with no snapshot at all", () => {
    expect(handedOutDid(snapshot([did(1)]))).toBeNull();
    expect(handedOutDid(snapshot([]))).toBeNull();
    expect(handedOutDid(null)).toBeNull();
  });

  it("passes over one retired, however it was disclosed", () => {
    expect(handedOutDid(snapshot([did(1, { live: false, retired: "rotated", disclosures: [{ as: "direct" }] })]))).toBeNull();
  });
});

describe("the link of an invitation the vault holds", () => {
  vi.stubGlobal("location", { origin: "https://estoc.example", pathname: "/" });
  const record: InvitationRecord = {
    disclosureEventCid: "bafyinvitation" as InvitationRecord["disclosureEventCid"],
    oobId: "019b0000-0000-7000-8000-00000000000b",
    didId: did(1).didId,
    localDid: "did:peer:4zD1",
    state: { status: "available" },
  };
  const over = (dids: LocalDid[], links: Record<string, string>) => {
    state.snapshot = { dids, invitations: [record] } as Snapshot;
    state.links = links;
  };

  it("is the one it was made as while this page remembers it", () => {
    over([did(1)], { [record.oobId]: "https://estoc.example/?_oob=made" });
    expect(invitationLink(record)).toBe("https://estoc.example/?_oob=made");
  });

  it("carries its DID's long form once this page has forgotten it, so a stranger handed it later can resolve the DID", () => {
    over([did(2), did(1)], {});
    expect(parseInvitation(invitationLink(record)!)).toMatchObject({ id: record.oobId, from: "did:peer:4zD1:zLong1" });
  });

  it("is null while the snapshot holds no long form for its DID", () => {
    over([did(1, { longFormDid: null })], {});
    expect(invitationLink(record)).toBeNull();
    over([did(2)], {});
    expect(invitationLink(record)).toBeNull();
  });
});
