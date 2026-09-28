import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiError, ChannelId, ContactId, ExecutionId, Hold, MessageId, MethodInput, MethodName } from "@estoc/daemon-api/contract";
import { Refusal, type MethodHandlers, type Session } from "@estoc/daemon-api/wire";
import type { Channel } from "@estoc/vault";

import { limitsOf, methodsOf } from "../src/adapter.js";
import { channelIdOf } from "../src/channels.js";
import { createDaemon, type DaemonCore, type DaemonHost } from "../src/index.js";
import { nodeHost } from "../src/node/index.js";

const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";
const PASSPHRASE = "alice-passes-the-salt";
const CONTACT = "018f0000-0000-7000-8000-000000000000" as ContactId;
const MESSAGE = "018f0000-0000-7000-8000-000000000001" as MessageId;
const OTHER_MESSAGE = "018f0000-0000-7000-8000-000000000002" as MessageId;
const HOLD = "019b0000-0000-7000-8000-0000000000aa" as Hold;

const roots: string[] = [];
const daemons: DaemonCore[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "estoc-adapter-"));
  roots.push(root);
  return root;
}

const vaultFile = (root: string) => path.join(root, ".estoc", "vault.sqlite");

const session = {} as Session;

/** The refusal `answer` ends in; a result, or anything else thrown, fails the test. */
async function refusalOf(answer: unknown): Promise<ApiError> {
  const outcome: unknown = await Promise.resolve(answer).then(
    (value) => new Error(`answered ${JSON.stringify(value)} instead of refusing`),
    (error: unknown) => error
  );
  if (!(outcome instanceof Refusal)) throw outcome;
  return outcome.error;
}

/** The daemon's methods as a view calls them, with no session to speak of. */
function methodsOver(host: DaemonHost, maxBackupBytes?: number): { daemon: DaemonCore; call: <Name extends Exclude<MethodName, "attach">>(name: Name, input: MethodInput<Name>) => Promise<unknown>; refused: (name: Exclude<MethodName, "attach">, input: unknown) => Promise<ApiError> } {
  const daemon = createDaemon(host, () => undefined);
  daemons.push(daemon);
  const methods = methodsOf(daemon, limitsOf("clone", maxBackupBytes));
  const call = (name: string, input: unknown) => (methods as Record<string, (input: unknown, session: Session) => Promise<unknown>>)[name]!(input, session);
  return {
    daemon,
    call: (name, input) => call(name, input),
    refused: (name, input) => refusalOf(call(name, input)),
  };
}

/** A did:peer:4 short form spelled from a name: the shape a channel end has, with no document behind it. */
const shortForm = (name: string): string => `did:peer:4zQm${name.padEnd(44, "1")}`;
const pairWith = (peer: string): Channel => ({ localDid: shortForm("Anna"), peerDid: shortForm(peer) }) as Channel;
const idsWith = (peer: string): ChannelId[] => [channelIdOf(pairWith(peer))];

const wrongPhase = (message: string): ApiError => ({ code: "WrongPhase", message, effect: "none", messageId: null });

const CONTENT = { type: BASIC_MESSAGE, body: { content: "hi" } };

describe("a lifecycle guard", () => {
  it("refuses with its code before anything is done: no files, no vault, one standing already, a hold that is not the vault's, a passphrase that does not open it", async () => {
    const root = await folder();
    const { daemon, call, refused } = methodsOver(nodeHost(root));
    expect(await refused("createIdentity", { name: "Alice", passphrase: PASSPHRASE })).toEqual(wrongPhase("the daemon holds no files here"));

    await daemon.boot();
    expect(await refused("forgetIdentity", { hold: HOLD })).toEqual(wrongPhase("there is no vault here to remove"));
    expect(await refused("unlock", { passphrase: PASSPHRASE })).toEqual(wrongPhase("nothing to unlock"));
    const needOpen: [Exclude<MethodName, "attach">, unknown][] = [
      ["exportBackup", {}],
      ["explainedRestore", {}],
      ["send", { target: { contactId: CONTACT }, content: CONTENT }],
      ["retry", { messageId: MESSAGE }],
      ["createContact", { petname: "Bob", channelIds: idsWith("Bob") }],
      ["rotate", { channelId: idsWith("Bob")[0] }],
      ["reconnect", {}],
      ["traceLevel", {}],
    ];
    for (const [name, input] of needOpen) expect(await refused(name, input)).toEqual(wrongPhase("no open vault"));
    await expect(stat(vaultFile(root))).rejects.toThrow();

    expect(await call("createIdentity", { name: "Alice", passphrase: PASSPHRASE })).toBeNull();
    expect(await refused("createIdentity", { name: "Again", passphrase: PASSPHRASE })).toEqual(wrongPhase("a vault already exists here"));
    expect(await refused("forgetIdentity", { hold: HOLD })).toEqual({ code: "StaleHold", message: expect.stringMatching(/^that vault is gone already/), effect: "none", messageId: null });
    expect(await call("lock", {})).toBeNull();
    expect(await refused("unlock", { passphrase: "wrong" })).toEqual({ code: "OperationFailed", message: "wrong passphrase", effect: "none", messageId: null });
    expect(await refused("forgetIdentity", { hold: HOLD })).toMatchObject({ code: "StaleHold" });
    expect(await refused("send", { target: { contactId: CONTACT }, content: CONTENT })).toEqual(wrongPhase("no open vault"));
    expect(await call("unlock", { passphrase: PASSPHRASE })).toBeNull();
    expect(daemon.publisher.current.state.value).toMatchObject({ phase: "open", snapshot: { label: "Alice" } });
    await stat(vaultFile(root));
  });

  it("refuses every file operation while the files are another daemon's", async () => {
    const root = await folder();
    const owner = methodsOver(nodeHost(root));
    await owner.daemon.boot();
    await owner.call("createIdentity", { name: "Alice", passphrase: PASSPHRASE });

    const other = methodsOver(nodeHost(root));
    const waiting = other.daemon.boot();
    while (other.daemon.publisher.current.state.value.phase !== "elsewhere") await new Promise((resolve) => setTimeout(resolve, 10));
    const elsewhere = wrongPhase("the vault is held elsewhere");
    expect(await other.refused("forgetIdentity", { hold: HOLD })).toEqual(elsewhere);
    expect(await other.refused("createIdentity", { name: "Mallory", passphrase: PASSPHRASE })).toEqual(elsewhere);
    expect(await other.refused("restoreIdentity", { backup: new Uint8Array(16), passphrase: PASSPHRASE })).toEqual(elsewhere);
    expect(await other.refused("lock", {})).toEqual(elsewhere);
    expect(await other.refused("send", { target: { contactId: CONTACT }, content: CONTENT })).toEqual(wrongPhase("no open vault"));
    await other.daemon.close();
    await waiting;
  });

  it("holds every send of the user's and every manual dispatch until the restore is explained, each refused with the one code and nothing recorded", async () => {
    const source = methodsOver(nodeHost(await folder()));
    await source.daemon.boot();
    await source.call("createIdentity", { name: "Alice", passphrase: PASSPHRASE });
    const backup = (await source.call("exportBackup", {})) as { bytes: Uint8Array };

    const { daemon, call, refused } = methodsOver(nodeHost(await folder()));
    await daemon.boot();
    expect(await call("restoreIdentity", { backup: backup.bytes, passphrase: PASSPHRASE })).toBeNull();
    const unexplained: ApiError = { code: "RestoreUnexplained", message: expect.stringMatching(/^this vault was restored/) as string, effect: "none", messageId: null };
    const invitation = { type: "https://didcomm.org/out-of-band/2.0/invitation", id: "inv-1", typ: "application/didcomm-plain+json", from: "did:peer:4zQmBob", body: {} };
    const held: [Exclude<MethodName, "attach">, unknown][] = [
      ["send", { target: { contactId: CONTACT }, content: CONTENT }],
      ["retry", { messageId: MESSAGE }],
      ["rotate", { channelId: idsWith("Bob")[0] }],
      ["completeResponse", { executionId: "00000000-0000-5000-8000-000000000000", effectType: "pure-ack" }],
      ["completeNotification", { rotationEventCid: "018f0000-0000-7000-8000-000000000000" }],
      ["acceptInvitation", { invitation, petname: "Bob" }],
      ["addContactByDid", { did: "did:peer:4zQmBob", petname: "Bob" }],
    ];
    for (const [name, input] of held) expect(await refused(name, input)).toEqual(unexplained);
    const shown = daemon.publisher.current.state.value;
    expect(shown).toMatchObject({ phase: "open", snapshot: { restoreUnexplained: true, messages: [], contacts: [] } });

    expect(await call("explainedRestore", {})).toBeNull();
    expect(daemon.publisher.current.state.value).toMatchObject({ phase: "open", snapshot: { restoreUnexplained: false } });
    // What the domain throws past the guards is no refusal of the adapter's: the server answers it as a failure.
    await expect(call("retry", { messageId: MESSAGE })).rejects.toThrow(`no message ${MESSAGE}`);
  });
});

describe("an input the schema admits", () => {
  it("is refused as invalid where the domain does not: a channel ID that is no pair's canonical text, a contact with no channel, a DID that is none or the vault's own", async () => {
    const { daemon, call, refused } = methodsOver(nodeHost(await folder()));
    await daemon.boot();
    await call("createIdentity", { name: "Alice", passphrase: PASSPHRASE });
    const invalid = (message: string | RegExp): ApiError => ({ code: "InvalidArgument", message: (typeof message === "string" ? message : expect.stringMatching(message)) as string, effect: "none", messageId: null });

    expect(await refused("send", { target: { channelId: "did:peer:4zQmBob" }, content: CONTENT })).toEqual(invalid("not a channel ID: not JSON"));
    expect(await refused("send", { target: { channelId: '["did:peer:4zQmAnna","did:peer:4zQmAnna"]' }, content: CONTENT })).toEqual(invalid(/^not a channel ID: /));
    expect(await refused("send", { target: { channelId: '["did:peer:4zQmAnna", "did:peer:4zQmBob"]' }, content: CONTENT })).toEqual(invalid("not a channel ID: not the canonical text of its pair"));
    expect(await refused("createContact", { petname: "Nobody", channelIds: [] })).toEqual(invalid("a contact is created with at least one channel"));
    expect(await refused("createContact", { petname: "Nobody", channelIds: ["[]"] })).toEqual(invalid(/^not a channel ID: /));
    expect(await refused("setContactChannels", { contactId: CONTACT, channelIds: ["nope"] })).toEqual(invalid(/^not a channel ID: /));
    expect(await refused("blockChannels", { channelIds: ["nope"], includeSuccessors: false })).toEqual(invalid(/^not a channel ID: /));
    expect(await refused("rotate", { channelId: "nope" })).toEqual(invalid(/^not a channel ID: /));
    expect(await refused("addContactByDid", { did: "not a did", petname: "Bob" })).toEqual(invalid(/^not a DID: /));
    expect(await refused("setMediator", { mediatorDid: "mediator.example" })).toEqual(invalid(/^not a DID: /));
    expect(await refused("resolveChannel", { localDid: "did:example:a", peerDid: "did:example:a" })).toEqual(invalid("a channel needs two distinct DIDs"));
    expect(await refused("resolveChannel", { localDid: "did:example:a", peerDid: "" })).toEqual(invalid(/^not a DID: /));
    expect(await refused("setTraceLevel", { level: "loud" })).toEqual(invalid("no such trace level: loud"));
    expect(await refused("renameContact", { contactId: CONTACT, petname: "Bobby" })).toEqual({ code: "OperationFailed", message: `no contact ${CONTACT}`, effect: "none", messageId: null });
    expect(daemon.publisher.current.state.value).toMatchObject({ phase: "open", snapshot: { contacts: [], channels: [], messages: [] } });
  });

  it("names a pair by its canonical text without a record of it: what the daemon would name the pair by, either way round, and nothing in the snapshot for it", async () => {
    const { daemon, call } = methodsOver(nodeHost(await folder()));
    await daemon.boot();
    await call("createIdentity", { name: "Alice", passphrase: PASSPHRASE });
    expect(await call("resolveChannel", { localDid: "did:example:alice", peerDid: "did:example:bob" })).toEqual({ channelId: '["did:example:alice","did:example:bob"]' });
    expect(await call("resolveChannel", { localDid: "did:example:bob", peerDid: "did:example:alice" })).toEqual({ channelId: '["did:example:bob","did:example:alice"]' });
    expect(daemon.publisher.current.state.value).toMatchObject({ phase: "open", snapshot: { channels: [] } });
  });
});

describe("a send the domain finds no target for", () => {
  it("is refused under the target's code, with no effect, and the contact's channel still takes nothing", async () => {
    const { daemon, call, refused } = methodsOver(nodeHost(await folder()));
    await daemon.boot();
    await call("createIdentity", { name: "Alice", passphrase: PASSPHRASE });
    const { contactId } = (await call("createContact", { petname: "Bob", channelIds: idsWith("Bob") })) as { contactId: string };
    expect(await refused("send", { target: { contactId }, content: CONTENT })).toEqual({ code: "NoTarget", message: expect.stringMatching(/cannot be written to/) as string, effect: "none", messageId: null });
    expect(await refused("send", { target: { channelId: idsWith("Bob")[0] }, content: CONTENT })).toEqual({ code: "SendClosed", message: expect.stringMatching(/is not usable/) as string, effect: "none", messageId: null });
    expect(daemon.publisher.current.state.value).toMatchObject({ phase: "open", snapshot: { messages: [] } });
  });
});

describe("an export", () => {
  it("over the backup bound is refused before the file is built, or before one built within it is read whole, and leaves no file behind", async () => {
    const root = await folder();
    const reads: (number | undefined)[] = [];
    const host = nodeHost(root);
    const watched: DaemonHost = {
      ...host,
      storage: async () => {
        const storage = await host.storage();
        return {
          ...storage,
          exportFile: (name, maxBytes) => {
            reads.push(maxBytes);
            return storage.exportFile(name, maxBytes);
          },
        };
      },
    };
    const { daemon, call, refused } = methodsOver(watched, 64);
    await daemon.boot();
    await call("createIdentity", { name: "Alice", passphrase: PASSPHRASE });
    const leftover = async () => (await readdir(path.join(root, ".estoc"))).filter((name) => !/^(vault|owner)\.sqlite/.test(name));

    expect(await refused("exportBackup", {})).toEqual({ code: "ResourceLimit", message: expect.stringMatching(/^the backup's events and objects come to \d+ bytes, over the 64 /) as string, effect: "none", messageId: null });
    expect(reads).toEqual([]);
    expect(await leftover()).toEqual([]);

    const loose = methodsOf(daemon, limitsOf("clone", 20_000));
    expect(await refusalOf(loose.exportBackup({}, session))).toEqual({ code: "ResourceLimit", message: expect.stringMatching(/^the backup file is \d+ bytes, over the 20000 /) as string, effect: "none", messageId: null });
    expect(reads).toEqual([20_000]);
    expect(await leftover()).toEqual([]);

    const { bytes } = (await methodsOf(daemon, limitsOf("clone")).exportBackup({}, session)) as { bytes: Uint8Array };
    expect(bytes.byteLength).toBeGreaterThan(20_000);
    expect(reads).toEqual([20_000, 512 * 1024 * 1024]);
    expect(await leftover()).toEqual([]);
  });
});

describe("a call that threw inside the daemon", () => {
  it("is answered as a failure with a possible effect, naming the message when the state published shows it, and what was thrown goes to the host's log", async () => {
    const failures: string[] = [];
    const threw = (messageId: MessageId | null) => ({ outcome: "threw" as const, because: "the disk is full for now", messageId });
    const core = {
      send: async () => ({ ...threw(MESSAGE), channel: pairWith("Bob") }),
      retry: async (messageId: MessageId) => threw(messageId),
      completeResponse: async () => threw(null),
      publisher: { current: { state: { value: { phase: "open", snapshot: { messages: [{ messageId: MESSAGE }] } } } } },
    } as unknown as DaemonCore;
    const methods = methodsOf(core, limitsOf("clone"), { failed: (error) => failures.push(error instanceof Error ? error.message : String(error)) });
    const failed = (messageId: MessageId | null): ApiError => ({ code: "OperationFailed", message: expect.stringMatching(/threw inside the daemon/) as string, effect: "possible", messageId });

    expect(await refusalOf(methods.send({ target: { contactId: CONTACT }, content: CONTENT }, session))).toEqual(failed(MESSAGE));
    expect(await refusalOf(methods.retry({ messageId: MESSAGE }, session))).toEqual(failed(MESSAGE));
    expect(await refusalOf(methods.retry({ messageId: OTHER_MESSAGE }, session))).toEqual(failed(null));
    expect(await refusalOf(methods.completeResponse({ executionId: "00000000-0000-5000-8000-000000000000" as ExecutionId, effectType: "pure-ack" }, session))).toEqual(failed(null));
    expect(failures).toEqual([`the call of ${MESSAGE} threw: the disk is full for now`, `the call of ${MESSAGE} threw: the disk is full for now`, `the call of ${OTHER_MESSAGE} threw: the disk is full for now`, "the call threw: the disk is full for now"]);
  });
});

describe("the methods table", () => {
  it("has every method of the API but attachment, and nothing of the daemon's own", () => {
    const daemon = createDaemon(nodeHost("/nonexistent"), () => undefined);
    const methods: MethodHandlers = methodsOf(daemon, limitsOf("text"));
    const names = Object.keys(methods).sort();
    expect(names).not.toContain("attach");
    expect(names).not.toContain("boot");
    expect(names).not.toContain("close");
    expect(names).toContain("refresh");
    expect(names).toContain("resolveChannel");
    expect(names).toHaveLength(30);
  });
});
