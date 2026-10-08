import { describe, expect, it } from "vitest";

import { longToShort, resolveDIDCommDoc, type Secret } from "@estoc/did-peer";
import { InvalidDidDocument, VaultEventSet, foldWithSeed, mediationIdOf, mediationKeyName, sameDid, scanVault, vaultDraft, type Did } from "@estoc/vault";

import { Message } from "@estoc/didcomm-node";

import {
  ACCOUNT_REGISTER,
  ACCOUNT_REGISTERED,
  Agent,
  AgentTrace,
  EntityConflict,
  LinkClosed,
  MediatorLink,
  RECIPIENT_ADDED,
  Unusable,
  UnverifiedReply,
  addRecipients,
  createDid,
  createMediation,
  enroll,
  holds,
  knownLongForms,
  plainMessage,
  secretsResolverFor,
  selectMediation,
  transientOptions,
  type IMessage,
} from "../src/index.js";
import { MEDIATOR_HTTP } from "./fake-mediator.js";
import { didcomm, freshVault, newMediator, party, reloaded, mediatedRoute, until } from "./helpers.js";

describe("creating an arrangement", () => {
  it("records the vault's identity toward the mediator before any request, under the ID the mediator's DID derives, and says the same again for the same mediator", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    expect(p.mediationId).toBe(mediationIdOf(mediator.did as Did));
    expect(p.created.data.me.keyName).toBe(mediationKeyName(p.mediationId));
    expect(p.created.data.me.did.startsWith("did:peer:4zQm")).toBe(true);
    expect(p.created.data.me.did).toContain(":z");
    expect(mediator.seenTypes).toEqual([]);
    const again = await createMediation(p.runtime, p.keys, mediator.did as Did);
    expect(again.cid).toBe(p.created.cid);
    const respelled = await createMediation(p.runtime, p.keys, longToShort(mediator.did) as Did);
    expect(respelled.cid).toBe(p.created.cid);
    const other = await createMediation(p.runtime, p.keys, (await newMediator(201, "http://other-mediator/")).did as Did);
    expect(other.data.mediationId).not.toBe(p.mediationId);
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.get(p.mediationId)?.status).toBe("pending");
    await p.runtime.close();
  });

  it("merges what two replicas of one seed recorded under the mediator's long and short form into one usable arrangement that routes the address minted on either", async () => {
    const mediator = await newMediator();
    const a = await party(mediator);
    await enroll(a.link, a.runtime, a.keys, a.confirmations, a.mediationId);
    const address = await createDid(a.runtime, a.keys, mediatedRoute(a.mediationId));
    const b = await freshVault(1, "the same seed elsewhere");
    const short = longToShort(mediator.did) as Did;
    const created = await createMediation(b.runtime, b.keys, short);
    expect(created.data).toEqual({ ...a.created.data, mediatorDid: short });
    await b.runtime.vault.commit([], [vaultDraft("mediation.granted", { mediationId: a.mediationId, routingDid: short })]);
    const joined = VaultEventSet.of([...(await scanVault(a.runtime.vault, a.keys)).set.all(), ...(await scanVault(b.runtime.vault, b.keys)).set.all()]);
    expect(joined.invalid).toEqual([]);
    const { mediations, dids } = await foldWithSeed(joined, a.keys);
    const merged = mediations.mediations.get(a.mediationId);
    expect(merged).toMatchObject({ status: "usable", faults: [] });
    expect([merged?.mediatorDid, merged?.routingDid].map((did) => sameDid(did ?? "", short))).toEqual([true, true]);
    expect(mediations.through(short).map((m) => m.mediationId)).toEqual([a.mediationId]);
    expect(dids.entities.get(address.created.data.didId)).toMatchObject({ live: true, mediation: a.mediationId });
    expect(dids.receipt(address.created.data.didId)).toBe("eligible");
    await a.runtime.close();
    await b.runtime.close();
  });

  it("records the creation of an arrangement whose grant arrived here first", async () => {
    const mediator = await newMediator();
    const p = await freshVault(1);
    const mediationId = mediationIdOf(mediator.did as Did);
    await p.runtime.vault.commit([], [vaultDraft("mediation.granted", { mediationId, routingDid: mediator.did as Did })]);
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.get(mediationId)).toMatchObject({ status: "pending", me: null });
    const created = await createMediation(p.runtime, p.keys, mediator.did as Did);
    expect(created.data.mediationId).toBe(mediationId);
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.get(mediationId)).toMatchObject({ status: "usable", me: { did: created.data.me.did } });
    await p.runtime.close();
  });

  it("keeps the long form a retry supplies for a mediator first arranged with by its short form, as one more creation of the one arrangement, so that the mediator resolves and the enrollment proceeds", async () => {
    const mediator = await newMediator();
    const p = await freshVault(1);
    const short = longToShort(mediator.did) as Did;
    const first = await createMediation(p.runtime, p.keys, short);
    const mediationId = first.data.mediationId;
    const options = { didcomm, fetch: ((input, init) => mediator.fetch(input, init)) as typeof fetch, WebSocket: mediator.WebSocket, trace: await AgentTrace.open(p.runtime.local), liveDelivery: false };
    const unresolved = await Agent.open(p, options);
    await expect(unresolved.enroll(mediationId)).rejects.toThrow(/does not resolve/);
    unresolved.close();
    expect(mediator.seenTypes).toEqual([]);

    const second = await createMediation(p.runtime, p.keys, mediator.did as Did);
    expect(second.cid).not.toBe(first.cid);
    expect(second.data).toEqual({ ...first.data, mediatorDid: mediator.did });
    let fold = await scanVault(p.runtime.vault, p.keys);
    expect(fold.mediations.mediations.get(mediationId)).toMatchObject({ status: "pending", faults: [], mediatorDid: short });
    expect(knownLongForms(fold)(short)).toBe(mediator.did);
    await createMediation(p.runtime, p.keys, mediator.did as Did);
    await createMediation(p.runtime, p.keys, short);
    fold = await scanVault(p.runtime.vault, p.keys);
    expect(fold.set.of("mediation.created")).toHaveLength(2);

    const agent = await Agent.open(p, options);
    expect((await agent.enroll(mediationId)).steps).toEqual(["account-registered", "replica-created", "replica-added"]);
    agent.close();
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.get(mediationId)?.status).toBe("usable");
    await p.runtime.close();
  });

  it("refuses a did:peer:4 long form whose document is not the one its hash commits to, and writes nothing", async () => {
    const mediator = await newMediator();
    const p = await freshVault(1);
    const tampered = (mediator.did.slice(0, -1) + (mediator.did.endsWith("a") ? "b" : "a")) as Did;
    await expect(createMediation(p.runtime, p.keys, tampered)).rejects.toBeInstanceOf(InvalidDidDocument);
    expect((await scanVault(p.runtime.vault, p.keys)).set.of("mediation.created")).toEqual([]);
    await p.runtime.close();
  });

  it("refuses to arrange again with a mediator whose recorded arrangement is in conflict", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await p.runtime.vault.commit([], [vaultDraft("mediation.granted", { mediationId: p.mediationId, routingDid: mediator.did as Did }), vaultDraft("mediation.granted", { mediationId: p.mediationId, routingDid: "did:web:elsewhere.example" as Did })]);
    await expect(createMediation(p.runtime, p.keys, mediator.did as Did)).rejects.toBeInstanceOf(EntityConflict);
    await p.runtime.close();
  });
});

describe("the line to the mediator", () => {
  it("takes only a reply the mediator sealed to the arrangement's identity: plaintext, anonymous, signed under an anonymous seal, another sealer and another recipient of ours are refused", async () => {
    const mediator = await newMediator();
    const impostor = await newMediator(201, "http://impostor/");
    const p = await party(mediator);
    const otherAccount = await createMediation(p.runtime, p.keys, impostor.did as Did);
    await reloaded(p);
    const to = p.created.data.me.did;
    let forge: ((message: IMessage) => Promise<string>) | null = null;
    const forged = (
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (forge === null) return mediator.fetch(input, init);
        const message = plainMessage(ACCOUNT_REGISTERED, impostor.did, to, { account: longToShort(to), routing_did: impostor.did });
        return new Response(await forge(message), { status: 200 });
      }) as typeof fetch
    );
    const link = new MediatorLink({ ...p.linkOptions, fetch: forged });
    const packWith = (secrets: Secret[]) => async (message: IMessage, from: string | null, recipient = to, signBy: string | null = null) =>
      (await new Message(message).pack_encrypted(recipient, from, signBy, { resolve: resolveDIDCommDoc }, secretsResolverFor(secrets), { forward: false }))[0];
    const forgeries: Record<string, (message: IMessage) => Promise<string>> = {
      plaintext: async (message) => JSON.stringify({ ...message, from: mediator.did }),
      anonymous: (message) => packWith(impostor.secrets)({ ...message, from: mediator.did }, null),
      "signed by the mediator, sealed anonymously": (message) => packWith(mediator.secrets)({ ...message, from: mediator.did }, null, to, mediator.did),
      "another sealer": (message) => packWith(impostor.secrets)(message, impostor.did),
      "another recipient": (message) => packWith(mediator.secrets)({ ...message, from: mediator.did, to: [otherAccount.data.me.did] }, mediator.did, otherAccount.data.me.did),
    };
    for (const [name, forgery] of Object.entries(forgeries)) {
      forge = forgery;
      await expect(enroll(link, p.runtime, p.keys, transientOptions(), p.mediationId), name).rejects.toBeInstanceOf(UnverifiedReply);
      expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.get(p.mediationId)?.status, name).toBe("pending");
    }
    expect((await p.trace.read({ type: "envelope.rejected" })).map((entry) => entry.data["reason"])).toEqual([
      "not authenticated encryption",
      "not authenticated encryption",
      "not authenticated encryption",
      `sealed by ${impostor.did}`,
      `sealed to ${otherAccount.data.me.did}`,
    ]);
    // the signed one did open as authenticated: the signature verified, and that is not what the boundary asks
    const signed = (await p.trace.read({ type: "envelope.open" })).find((entry) => entry.data["sign_from"] !== undefined);
    expect(signed?.data["from_kid"]).toBeUndefined();
    expect(String(signed?.data["sign_from"]).startsWith(`${mediator.did}#`)).toBe(true);
    forge = null;
    expect((await enroll(link, p.runtime, p.keys, transientOptions(), p.mediationId)).mediation.routingDid).toBe(mediator.did);
    await p.runtime.close();
  });

  it("takes the mediator's reply with its sender protected: an anonymous layer over the mediator's authcrypt still proves it", async () => {
    const mediator = await newMediator();
    mediator.protectSender = true;
    const p = await party(mediator);
    const opened = await p.link.exchange(ACCOUNT_REGISTER, {});
    expect(opened.msg.type).toBe(ACCOUNT_REGISTERED);
    expect(opened.metadata).toMatchObject({ encrypted: true, authenticated: true, anonymous_sender: true });
    expect(opened.sender).toBe(mediator.did);
    expect((await enroll(p.link, p.runtime, p.keys, transientOptions(), p.mediationId)).mediation.status).toBe("usable");
    expect(await p.trace.read({ type: "envelope.rejected" })).toEqual([]);
    await p.runtime.close();
  });

  it("refuses a forged reply by the deadline even when the note of the refusal never settles, and the account's next procedure goes on", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await enroll(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    const a = await createDid(p.runtime, p.keys, mediatedRoute(p.mediationId));
    const stalled = Object.create(p.trace) as AgentTrace;
    (stalled as { append: AgentTrace["append"] }).append = (stream, what, data) => (stream === "envelope" && what === "rejected" ? new Promise(() => undefined) : p.trace.append(stream, what, data));
    const forged = plainMessage(RECIPIENT_ADDED, mediator.did, p.link.me, { recipient_did: a.minted.did, added_time: 1 });
    const link = new MediatorLink({ ...p.linkOptions, trace: stalled, timeoutMs: 300, fetch: async () => new Response(JSON.stringify(forged), { status: 200 }) });
    const started = Date.now();
    const first = addRecipients(link, p.runtime, p.keys, p.confirmations, p.mediationId);
    const second = addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    await expect(first).rejects.toBeInstanceOf(UnverifiedReply);
    expect(holds(await second, a.minted.did)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(p.log).toContain("trace not written: the deadline passed while noting");
    await p.runtime.close();
  });
});

describe("the line to a holder that closed", () => {
  it("sends nothing once its holder closed, however far the request got: the frame is traced as not sent, the ritual fails, and no socket is opened", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    let closed = false;
    const tracing = Object.create(p.trace) as AgentTrace;
    (tracing as { append: AgentTrace["append"] }).append = (stream, what, data) => {
      if (stream === "wire" && what === "out") closed = true;
      return p.trace.append(stream, what, data);
    };
    const link = new MediatorLink({ ...p.linkOptions, trace: tracing, closed: () => closed });
    await expect(link.roundTrip(ACCOUNT_REGISTER, {})).rejects.toBeInstanceOf(LinkClosed);
    expect(mediator.seenTypes).toEqual([]);
    expect((await p.trace.read({ type: "wire.error" })).map((entry) => entry.data["error"])).toEqual(["the holder of the link is closed"]);
    expect(() => link.openSocket(() => undefined)).toThrow(LinkClosed);
    expect(link.live).toBe(false);
    await p.runtime.close();
  });

  it("hands down the frames of the socket it has now alone: one still being opened when the socket was closed is dropped before it is handed over", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    const frames: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let stage: "armed" | "held" | "noted" = "armed";
    const tracing = Object.create(p.trace) as AgentTrace;
    (tracing as { append: AgentTrace["append"] }).append = async (stream, what, data) => {
      if (stage !== "armed" || stream !== "wire" || what !== "in") return p.trace.append(stream, what, data);
      stage = "held";
      await held;
      const seq = await p.trace.append(stream, what, data);
      stage = "noted";
      return seq;
    };
    const link = new MediatorLink({ ...p.linkOptions, trace: tracing });
    link.openSocket((opened) => void frames.push(opened.msg.type));
    await until("the status has come down the socket", () => stage === "held");
    link.closeSocket();
    release();
    await until("the late status is noted", () => stage === "noted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toEqual([]);
    expect(p.log).toContain("a socket frame was dropped: the socket it came down is no longer the line's");
    await p.runtime.close();
  });
});

describe("selecting", () => {
  it("records the preferred arrangement once it is usable, and nothing twice", async () => {
    const p = await party(await newMediator());
    await expect(selectMediation(p.runtime, p.keys, p.mediationId)).rejects.toBeInstanceOf(Unusable);
    await enroll(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    const selected = await selectMediation(p.runtime, p.keys, p.mediationId);
    expect(selected?.data).toEqual({ mediationId: p.mediationId });
    expect(await selectMediation(p.runtime, p.keys, p.mediationId)).toBeNull();
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.preferred).toBe(p.mediationId);
    await p.runtime.close();
  });
});

describe("the ring over the arrangement", () => {
  it("holds the identity the mediator knows the vault by, in both spellings", async () => {
    const p = await party(await newMediator());
    await reloaded(p);
    const me = p.created.data.me.did;
    expect(p.ring.secrets().map((s) => s.id)).toContain(`${longToShort(me)}#key-2`);
    expect(MEDIATOR_HTTP).toBe("http://fake-mediator/");
    await p.runtime.close();
  });
});
