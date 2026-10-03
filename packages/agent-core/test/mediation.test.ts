import { describe, expect, it } from "vitest";

import { longToShort, resolveDIDCommDoc, type Secret } from "@estoc/did-peer";
import { mediationKeyName, scanVault, type Did } from "@estoc/vault";

import { Message } from "@estoc/didcomm-node";

import {
  ACCOUNT_REGISTER,
  ACCOUNT_REGISTERED,
  AgentTrace,
  EntityConflict,
  MediatorLink,
  RECIPIENT_ADDED,
  Unusable,
  UnverifiedReply,
  addRecipients,
  createDid,
  createMediation,
  enroll,
  holds,
  plainMessage,
  secretsResolverFor,
  selectMediation,
  transientConfirmations,
  type IMessage,
} from "../src/index.js";
import { MEDIATOR_HTTP } from "./fake-mediator.js";
import { newMediator, party, reloaded, mediatedRoute } from "./helpers.js";

describe("creating an arrangement", () => {
  it("records the vault's identity toward the mediator before any request, and says the same again for the same ID", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    expect(p.created.data.me.keyName).toBe(mediationKeyName(p.mediationId));
    expect(p.created.data.me.did.startsWith("did:peer:4zQm")).toBe(true);
    expect(p.created.data.me.did).toContain(":z");
    expect(mediator.seenTypes).toEqual([]);
    const again = await createMediation(p.runtime, p.keys, mediator.did as Did, p.mediationId);
    expect(again.cid).toBe(p.created.cid);
    const other = await newMediator(201, "http://other-mediator/");
    await expect(createMediation(p.runtime, p.keys, other.did as Did, p.mediationId)).rejects.toBeInstanceOf(EntityConflict);
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.get(p.mediationId)?.status).toBe("pending");
    await p.runtime.close();
  });
});

describe("the line to the mediator", () => {
  it("takes only a reply the mediator sealed to the arrangement's identity: plaintext, anonymous, signed under an anonymous seal, another sealer and another recipient of ours are refused", async () => {
    const mediator = await newMediator();
    const impostor = await newMediator(201, "http://impostor/");
    const p = await party(mediator);
    const otherAccount = await createMediation(p.runtime, p.keys, mediator.did as Did);
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
      await expect(enroll(link, p.runtime, p.keys, transientConfirmations(), p.mediationId), name).rejects.toBeInstanceOf(UnverifiedReply);
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
    expect((await enroll(link, p.runtime, p.keys, transientConfirmations(), p.mediationId)).mediation.routingDid).toBe(mediator.did);
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
    expect((await enroll(p.link, p.runtime, p.keys, transientConfirmations(), p.mediationId)).mediation.status).toBe("usable");
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
