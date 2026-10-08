import { describe, expect, it } from "vitest";

import type * as read from "@estoc/agent-core";
import { BASIC_MESSAGE, PROFILE } from "@estoc/agent-core";
import { schemas, type ChannelId, type ConversationRecord, type Snapshot } from "@estoc/daemon-api/contract";
import type { Cid, JsonObject } from "@estoc/event-store";
import { channelOf as pairOf, type Channel, type ContactId, type Did, type DidId, type EventCid, type ExecutionId, type MessageId, type StoredAttachment } from "@estoc/vault";

import { channelIdOf } from "../src/channels.js";
import { project, type ReadVault } from "../src/projection.js";
import { resolves } from "./snapshots.js";

const did = (name: string): Did => `did:example:${name}` as Did;
const pair = (local: string, peer: string): Channel => pairOf(did(local), did(peer));
const idOf = (local: string, peer: string): ChannelId => channelIdOf(pair(local, peer));
const at = (second: number): string => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;

const VAULT: ReadVault = { anchor: "did:key:zAlice", label: "Alice", restoreUnexplained: false, mediations: [], dids: [] };
const OPEN = { status: "open" } as const;
const CLOSED = { status: "closed", because: "superseded" } as const;

interface MessageOptions {
  type?: string;
  body?: Record<string, unknown>;
  state?: "available" | "erased" | "missing";
  attachments?: StoredAttachment[];
  headers?: boolean;
  contactIds?: string[];
}

function message(direction: "in" | "out", messageId: string, channel: Channel | null, time: string, options: MessageOptions = {}): read.MessageRecord {
  const { type = BASIC_MESSAGE, body = { content: `body of ${messageId}` }, state = "available", attachments = [], headers = true, contactIds = [] } = options;
  return {
    messageId: messageId as MessageId,
    direction,
    channel,
    contactIds: contactIds as ContactId[],
    at: time,
    msg: headers ? { type, thid: null, pthid: null, createdTime: null, expiresTime: null } : null,
    body: state === "available" ? { state, body: body as JsonObject, attachments } : { state },
    kind: direction === "in" ? "application" : null,
    effectType: null,
    input: direction === "in" ? { status: "complete" } : null,
    outcome: direction === "out" ? { status: "submitted" } : null,
    acknowledged: false,
    late: false,
    verification: { status: "not-present" },
    manualAction: "none",
    completes: [],
    diagnostics: [],
  };
}

function observation(sourceEventCid: string, messageId: string, channel: Channel | null, time: string, disposition: read.DispositionRecord = { status: "admitted" }): read.ObservationRecord {
  return { sourceEventCid: sourceEventCid as EventCid, messageId: messageId as MessageId, channel, at: time, standing: { status: "complete" }, verification: { status: "verified" }, disposition, contradicting: false };
}

interface ChannelOptions {
  head?: Channel | null;
  send?: read.ChannelRecord["send"];
  peerName?: { name: string; messageId: string } | null;
  messages?: read.MessageRecord[];
  observations?: read.ObservationRecord[];
  superseded?: boolean;
}

function channel(pair: Channel, options: ChannelOptions = {}): read.ChannelRecord {
  const { head = null, send = OPEN, peerName = null, messages = [], observations = [], superseded = false } = options;
  return { channel: pair, head, superseded, blocked: false, conflicted: false, send, peerName: peerName === null ? null : { name: peerName.name, messageId: peerName.messageId as MessageId }, profileSubmitted: null, messages, observations };
}

interface ContactOptions {
  writeTo?: Channel[];
  defaultWriteTo?: Channel | null;
  preference?: { didId: string; matches: Channel[] } | null;
  diagnostics?: string[];
}

function contact(contactId: string, petname: string, shown: [read.ChannelRecord, boolean][], options: ContactOptions = {}): [ContactId, read.ContactRecord] {
  const selected = shown.filter(([, isSelected]) => isSelected).map(([record]) => record.channel);
  const { writeTo = selected, defaultWriteTo = writeTo.length === 1 ? writeTo[0]! : null, preference = null, diagnostics = [] } = options;
  return [
    contactId as ContactId,
    {
      contacts: [{ contactId: contactId as ContactId, origin: "user", deleted: false, petname }],
      petname,
      flags: {},
      channels: shown.map(([record, isSelected]) => ({ ...record, selected: isSelected })),
      writeTo,
      defaultWriteTo,
      preference: preference === null ? null : { didId: preference.didId as DidId, matches: preference.matches },
      diagnostics,
    },
  ];
}

interface Read {
  contacts?: [ContactId, read.ContactRecord][];
  /** the channels a message or an observation is shown in */
  channels?: read.ChannelRecord[];
  unplaced?: read.Unplaced;
  pending?: Partial<read.PendingWork>;
}

/** A read model built by hand; a channel it was not given is read as a bare pair, and `asked` says which were. */
function reader({ contacts = [], channels = [], unplaced = { inputs: [], outputs: [] }, pending = {} }: Read): read.Recorder & { asked: Channel[] } {
  const known = new Map<ChannelId, read.ChannelRecord>();
  for (const [, record] of contacts) for (const shown of record.channels) known.set(channelIdOf(shown.channel), shown);
  for (const record of channels) known.set(channelIdOf(record.channel), record);
  const asked: Channel[] = [];
  return {
    asked,
    channels: () => channels.map((record) => record.channel),
    unplaced: async () => unplaced,
    contactIds: () => contacts.map(([contactId]) => contactId).sort(),
    channel: async (pair) => {
      asked.push(pair);
      return known.get(channelIdOf(pair)) ?? channel(pair);
    },
    contact: async (contactId) => contacts.find(([id]) => id === contactId)![1],
    invitations: () => [],
    pending: () => ({ pendingOutbounds: [], missingResponses: [], rotationCandidates: [], missingNotifications: [], notificationConflicts: [], pendingProofs: [], ...pending }),
  };
}

/** The snapshot of `read`, checked against the API's schema and for its references. */
async function snapshotOf(read: Read, vault = VAULT): Promise<Snapshot> {
  const snapshot = await project(reader(read), vault);
  expect(schemas.snapshot.parse(snapshot)).toEqual(snapshot);
  resolves(snapshot);
  return snapshot;
}

const conversation = (snapshot: Snapshot, id: string): ConversationRecord => snapshot.conversations.find((record) => record.id === id)!;

describe("the snapshot", () => {
  const P = pair("a0", "b0");
  const H = pair("a1", "b0");

  it("shows a contact's selected head with the predecessor its continuity reaches, in one conversation, the predecessor no nameless conversation of its own", async () => {
    const predecessor = channel(P, { head: H, superseded: true, send: CLOSED, messages: [message("in", "m1", P, at(1), { contactIds: ["c1"] })], observations: [observation("o1", "m1", P, at(1)), observation("o2", "m2", P, at(2), { status: "pending-admission", because: "no proof yet" })] });
    const head = channel(H, { head: H, messages: [message("out", "m2", H, at(3)), message("in", "m3", H, at(2))], observations: [observation("o3", "m3", H, at(2))] });
    const snapshot = await snapshotOf({
      contacts: [contact("c1", "Bob", [[head, true], [predecessor, false]], { preference: { didId: "d1", matches: [H] } })],
      channels: [predecessor, head],
    });
    expect(snapshot.conversations.map(({ id }) => id)).toEqual(["contact:c1"]);
    expect(conversation(snapshot, "contact:c1")).toEqual({
      id: "contact:c1",
      contactId: "c1",
      petname: "Bob",
      claimedName: null,
      channels: [
        { channelId: idOf("a1", "b0"), selected: true },
        { channelId: idOf("a0", "b0"), selected: false },
      ],
      writeTo: [idOf("a1", "b0")],
      defaultWriteTo: idOf("a1", "b0"),
      messageIds: ["m1", "m3", "m2"],
      unadmittedObservationIds: ["o2"],
      diagnostics: [],
    });
    expect(snapshot.contacts).toEqual([{ contactId: "c1", origin: "user", flags: {}, preference: { didId: "d1", channelIds: [idOf("a1", "b0")] } }]);
    expect(snapshot.channels.map(({ channelId, headChannelId, superseded, send, messageIds, observationIds }) => ({ channelId, headChannelId, superseded, send, messageIds, observationIds }))).toEqual([
      { channelId: idOf("a0", "b0"), headChannelId: idOf("a1", "b0"), superseded: true, send: CLOSED, messageIds: ["m1"], observationIds: ["o1", "o2"] },
      { channelId: idOf("a1", "b0"), headChannelId: idOf("a1", "b0"), superseded: false, send: OPEN, messageIds: ["m3", "m2"], observationIds: ["o3"] },
    ]);
    expect(snapshot.messages.map(({ messageId, channelId, contactIds, direction }) => ({ messageId, channelId, contactIds, direction }))).toEqual([
      { messageId: "m1", channelId: idOf("a0", "b0"), contactIds: ["c1"], direction: "in" },
      { messageId: "m2", channelId: idOf("a1", "b0"), contactIds: [], direction: "out" },
      { messageId: "m3", channelId: idOf("a1", "b0"), contactIds: [], direction: "in" },
    ]);
    expect(snapshot.observations.map(({ sourceEventCid, disposition }) => [sourceEventCid, disposition.status])).toEqual([
      ["o1", "admitted"],
      ["o2", "pending-admission"],
      ["o3", "admitted"],
    ]);
    expect(snapshot).toMatchObject({ anchor: "did:key:zAlice", label: "Alice", restoreUnexplained: false, unplaced: { observationIds: [], outputs: [] } });
  });

  it("keeps one record of a channel two contacts show, each conversation referring to it", async () => {
    const shared = channel(P, { messages: [message("in", "m1", P, at(1), { contactIds: ["c1", "c2"] })] });
    const snapshot = await snapshotOf({ contacts: [contact("c2", "Robert", [[shared, true]]), contact("c1", "Bob", [[shared, true]])], channels: [shared] });
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.contacts.map(({ contactId }) => contactId)).toEqual(["c1", "c2"]);
    expect(snapshot.conversations.map(({ id, messageIds }) => [id, messageIds])).toEqual([
      ["contact:c1", ["m1"]],
      ["contact:c2", ["m1"]],
    ]);
  });

  it("groups the channels no contact shows under their heads, writing only to a head that is one of them and takes a send", async () => {
    const C1 = pair("a1", "b1");
    const C2 = pair("a2", "b1");
    const C3 = pair("a3", "b3");
    const C4 = pair("a4", "b3");
    const C5 = pair("a5", "b5");
    const C6 = pair("a6", "b6");
    const C7 = pair("a7", "b6");
    const C8 = pair("a8", "b8");
    const C9 = pair("a9", "b8");
    const named = channel(C4, { head: C4, messages: [message("in", "m4", C4, at(4))] });
    const snapshot = await snapshotOf({
      contacts: [contact("c1", "Bob", [[named, true]])],
      channels: [
        channel(C2, { head: C2, messages: [message("out", "m2", C2, at(2))] }),
        channel(C1, { head: C2, superseded: true, send: CLOSED, messages: [message("in", "m1", C1, at(1))], observations: [observation("o1", "m1", C1, at(1)), observation("o1b", "m1b", C1, at(1), { status: "refused", because: "unknown sender" })] }),
        channel(C3, { head: C4, superseded: true, send: CLOSED, messages: [message("in", "m3", C3, at(3))] }),
        channel(C5, { head: null, send: CLOSED, messages: [message("in", "m5", C5, at(5))] }),
        channel(C6, { head: C7, superseded: true, send: CLOSED, messages: [message("in", "m6", C6, at(6))] }),
        channel(C8, { head: C9, superseded: true, send: CLOSED, messages: [message("in", "m8", C8, at(8))] }),
        channel(C9, { head: C9, send: CLOSED, messages: [] }),
      ],
    });
    const nameless = snapshot.conversations.filter(({ contactId }) => contactId === null);
    expect(nameless.map(({ id, channels, writeTo, defaultWriteTo, messageIds, unadmittedObservationIds }) => ({ id, channels, writeTo, defaultWriteTo, messageIds, unadmittedObservationIds }))).toEqual([
      {
        id: `channel:${idOf("a2", "b1")}`,
        channels: [
          { channelId: idOf("a1", "b1"), selected: false },
          { channelId: idOf("a2", "b1"), selected: false },
        ],
        writeTo: [idOf("a2", "b1")],
        defaultWriteTo: idOf("a2", "b1"),
        messageIds: ["m1", "m2"],
        unadmittedObservationIds: ["o1b"],
      },
      { id: `channel:${idOf("a4", "b3")}`, channels: [{ channelId: idOf("a3", "b3"), selected: false }], writeTo: [], defaultWriteTo: null, messageIds: ["m3"], unadmittedObservationIds: [] },
      { id: `channel:${idOf("a5", "b5")}`, channels: [{ channelId: idOf("a5", "b5"), selected: false }], writeTo: [], defaultWriteTo: null, messageIds: ["m5"], unadmittedObservationIds: [] },
      {
        id: `channel:${idOf("a7", "b6")}`,
        channels: [
          { channelId: idOf("a6", "b6"), selected: false },
          { channelId: idOf("a7", "b6"), selected: false },
        ],
        writeTo: [idOf("a7", "b6")],
        defaultWriteTo: idOf("a7", "b6"),
        messageIds: ["m6"],
        unadmittedObservationIds: [],
      },
      {
        id: `channel:${idOf("a9", "b8")}`,
        channels: [
          { channelId: idOf("a8", "b8"), selected: false },
          { channelId: idOf("a9", "b8"), selected: false },
        ],
        writeTo: [],
        defaultWriteTo: null,
        messageIds: ["m8"],
        unadmittedObservationIds: [],
      },
    ]);
    expect(conversation(snapshot, "contact:c1").channels).toEqual([{ channelId: idOf("a4", "b3"), selected: true }]);
    const heads = snapshot.channels.filter(({ channelId }) => channelId === idOf("a7", "b6"));
    expect(heads).toMatchObject([{ headChannelId: null, messageIds: [], observationIds: [] }]);
  });

  it("names a conversation by the latest claim still readable in its channel: by time, then by message ID, an erased or missing claim giving no name", async () => {
    const claims = (older: MessageOptions, newer: MessageOptions) => ({
      contacts: [
        contact("c1", "Bob", [
          [channel(H, { head: H, peerName: { name: "Ally", messageId: "m-b" }, messages: [message("in", "m-b", H, at(5), { type: PROFILE, body: { profile: { displayName: "Ally" } }, ...newer })] }), true],
          [channel(P, { head: H, superseded: true, send: CLOSED, peerName: { name: "Alice", messageId: "m-a" }, messages: [message("in", "m-a", P, at(5), { type: PROFILE, body: { profile: { displayName: "Alice" } }, ...older })] }), false],
        ]),
      ],
    });
    expect(conversation(await snapshotOf(claims({}, {})), "contact:c1").claimedName).toEqual({ name: "Ally", messageId: "m-b" });
    expect(conversation(await snapshotOf(claims({}, { state: "erased" })), "contact:c1").claimedName).toEqual({ name: "Alice", messageId: "m-a" });
    expect(conversation(await snapshotOf(claims({ state: "missing" }, { state: "erased" })), "contact:c1").claimedName).toBeNull();
    const later = await snapshotOf({
      contacts: [
        contact("c1", "Bob", [
          [channel(H, { head: H, peerName: { name: "Ally", messageId: "m-b" }, messages: [message("in", "m-b", H, at(4), { type: PROFILE, body: { profile: { displayName: "Ally" } } })] }), true],
          [channel(P, { head: H, superseded: true, send: CLOSED, peerName: { name: "Alice", messageId: "m-a" }, messages: [message("in", "m-a", P, at(5), { type: PROFILE, body: { profile: { displayName: "Alice" } } })] }), false],
        ]),
      ],
    });
    expect(conversation(later, "contact:c1").claimedName).toEqual({ name: "Alice", messageId: "m-a" });
    expect(later.channels.map(({ peerName }) => peerName)).toEqual([
      { name: "Alice", messageId: "m-a" },
      { name: "Ally", messageId: "m-b" },
    ]);
  });

  it("lists an output no pair is fixed for among the messages, with every candidate pair in the channel table, and an observation no pair is known for among the observations", async () => {
    const X = pair("a1", "b1");
    const Y = pair("a2", "b1");
    const adrift = message("out", "m-out", null, at(3));
    const snapshot = await snapshotOf({
      unplaced: { inputs: [observation("o-anon", "m-anon", null, at(2))], outputs: [{ candidates: [Y, X], message: adrift }] },
    });
    expect(snapshot.unplaced).toEqual({ observationIds: ["o-anon"], outputs: [{ messageId: "m-out", candidateChannelIds: [idOf("a1", "b1"), idOf("a2", "b1")] }] });
    expect(snapshot.messages).toMatchObject([{ messageId: "m-out", channelId: null, direction: "out" }]);
    expect(snapshot.observations).toMatchObject([{ sourceEventCid: "o-anon", channelId: null }]);
    expect(snapshot.channels.map(({ channelId, messageIds }) => [channelId, messageIds])).toEqual([
      [idOf("a1", "b1"), []],
      [idOf("a2", "b1"), []],
    ]);
    expect(snapshot.conversations.map(({ id, messageIds }) => [id, messageIds])).toEqual([
      [`channel:${idOf("a1", "b1")}`, []],
      [`channel:${idOf("a2", "b1")}`, []],
    ]);
  });

  it("takes the pairs the pending work names into the channel table", async () => {
    const owed = pair("a1", "b1");
    const proof = pair("a2", "b2");
    const snapshot = await snapshotOf({
      pending: {
        missingResponses: [{ executionId: "x1" as ExecutionId, messageId: "m1" as MessageId, effectType: "pure-ack", channel: owed, entries: ["completeResponse"] }],
        pendingProofs: [{ sourceEventCid: "o1" as EventCid, messageId: "m2" as MessageId, channel: proof, entries: [] }],
        pendingOutbounds: [{ messageId: "m3" as MessageId, channel: null, outcome: "queued", candidates: [], selected: null, because: null, entries: ["retry", "cancel"] }],
      },
    });
    expect(snapshot.pending).toEqual({
      pendingOutbounds: [{ messageId: "m3", channelId: null, outcome: "queued", because: null, entries: ["retry", "cancel"] }],
      missingResponses: [{ executionId: "x1", messageId: "m1", effectType: "pure-ack", channelId: idOf("a1", "b1"), entries: ["completeResponse"] }],
      rotationCandidates: [],
      missingNotifications: [],
      notificationConflicts: [],
      pendingProofs: [{ sourceEventCid: "o1", messageId: "m2", channelId: idOf("a2", "b2"), entries: [] }],
    });
    expect(snapshot.channels.map(({ channelId }) => channelId)).toEqual([idOf("a1", "b1"), idOf("a2", "b2")]);
  });

  it("orders every table by ID and every reference list by time then ID, whatever order the read gave", async () => {
    const X = pair("b", "z");
    const Y = pair("a", "z");
    const snapshot = await snapshotOf({
      channels: [
        channel(X, { messages: [message("in", "m-c", X, at(1)), message("out", "m-a", X, at(1)), message("in", "m-b", X, at(0))], observations: [observation("o-b", "m-b", X, at(0)), observation("o-a", "m-a", X, at(0)), observation("o-c", "m-c", X, at(1))] }),
        channel(Y),
      ],
    });
    expect(snapshot.channels.map(({ channelId }) => channelId)).toEqual([idOf("a", "z"), idOf("b", "z")]);
    expect(snapshot.messages.map(({ messageId }) => messageId)).toEqual(["m-a", "m-b", "m-c"]);
    expect(snapshot.observations.map(({ sourceEventCid }) => sourceEventCid)).toEqual(["o-a", "o-b", "o-c"]);
    expect(snapshot.channels[1]).toMatchObject({ messageIds: ["m-b", "m-a", "m-c"], observationIds: ["o-a", "o-b", "o-c"] });
    expect(snapshot.conversations.map(({ id }) => id)).toEqual([`channel:${idOf("a", "z")}`, `channel:${idOf("b", "z")}`]);
    const vault: ReadVault = {
      ...VAULT,
      mediations: [
        { mediationId: "m2" as never, mediatorDid: null, selected: false, usable: false, retired: "gone", diagnostics: [] },
        { mediationId: "m1" as never, mediatorDid: "did:example:m", selected: true, usable: true, retired: null, diagnostics: ["slow"] },
      ],
      dids: [
        { didId: "d2" as never, did: null, longFormDid: null, live: false, retired: null, disclosures: [], diagnostics: [] },
        { didId: "d1" as never, did: "did:example:a", longFormDid: "did:example:a", live: true, retired: null, disclosures: [{ as: "oob" }], diagnostics: [] },
      ],
    };
    const ordered = await snapshotOf({}, vault);
    expect(ordered.mediations.map(({ mediationId }) => mediationId)).toEqual(["m1", "m2"]);
    expect(ordered.dids.map(({ didId }) => didId)).toEqual(["d1", "d2"]);
  });

  it("summarizes what it can read, describes attachments without their payloads, and carries the rest of a message as it is", async () => {
    const X = pair("a", "b");
    const image: StoredAttachment = { id: "img", description: "a picture", filename: "x.png", media_type: "image/png", format: null, lastmod_time: 1_700_000_000 as never, byte_count: 12, data: { kind: "base64", root: "bafkreiimage" as Cid, hash: "sha-256:abc", jws: { signature: "..." } } };
    const linked: StoredAttachment = { id: null, description: null, filename: null, media_type: null, format: "dag-json", lastmod_time: null, byte_count: null, data: { kind: "links", links: ["https://example.net/x"], hash: "sha-256:def", jws: null } };
    const said = message("in", "m-said", X, at(1), { body: { content: "first line\nsecond" }, attachments: [image, linked] });
    said.diagnostics = [{ kind: "remote-error", because: "peer says no", report: "m-report" as MessageId }, { kind: "work", because: "waiting" }];
    const snapshot = await snapshotOf({
      channels: [
        channel(X, {
          messages: [
            said,
            message("in", "m-profile", X, at(2), { type: PROFILE, body: { profile: { displayName: "Bob" } } }),
            message("in", "m-erased", X, at(3), { state: "erased" }),
            message("out", "m-unagreed", X, at(4), { headers: false, state: "missing" }),
            message("in", "m-report", X, at(5), { type: "https://didcomm.org/report-problem/2.0/problem-report", body: { code: "e.p.msg" } }),
          ],
        }),
      ],
    });
    const byId = new Map(snapshot.messages.map((record) => [record.messageId, record]));
    expect(byId.get("m-said" as never)).toMatchObject({
      summary: "first line second",
      headers: { type: BASIC_MESSAGE, thid: null, pthid: null, createdTime: null, expiresTime: null },
      body: {
        state: "available",
        body: { content: "first line\nsecond" },
        attachments: [
          { id: "img", description: "a picture", filename: "x.png", mediaType: "image/png", format: null, lastModifiedTime: 1_700_000_000, byteCount: 12, content: { kind: "base64", cid: "bafkreiimage" }, hash: "sha-256:abc", signed: true },
          { id: null, description: null, filename: null, mediaType: null, format: "dag-json", lastModifiedTime: null, byteCount: null, content: { kind: "links", links: ["https://example.net/x"] }, hash: "sha-256:def", signed: false },
        ],
      },
      diagnostics: [
        { kind: "remote-error", because: "peer says no", reportMessageId: "m-report" },
        { kind: "work", because: "waiting", reportMessageId: null },
      ],
      input: { status: "complete" },
      delivery: null,
      kind: "application",
    });
    expect(byId.get("m-profile" as never)?.summary).toBe("name: Bob");
    expect(byId.get("m-erased" as never)).toMatchObject({ summary: null, body: { state: "erased" } });
    expect(byId.get("m-unagreed" as never)).toMatchObject({ summary: null, headers: null, body: { state: "missing" }, delivery: { status: "submitted" }, input: null });
    expect(byId.get("m-report" as never)?.summary).toBeNull();
  });
});
