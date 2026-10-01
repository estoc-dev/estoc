import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Hono } from "hono";
import type { IMessage } from "@estoc/didcomm-node";
import { CompactSign, importJWK } from "jose";
import canonicalize from "canonicalize";
import bs58 from "bs58";
import { bytesToBase64url, encodeLongForm, longToShort } from "@estoc/did-peer";

import { replicaPolicyFrom, type MediatorConfig } from "../src/config.js";
import type { DIDCommContext } from "../src/didcomm/didcomm.js";
import WebSocket from "ws";
import { buildServer, type MediatorServer } from "../src/server.js";
import { mintIdentity, type MediatorIdentity } from "../src/identity-core.js";
import { SqliteStore } from "../src/store/sqlite.js";
import {
  ENCRYPTED,
  forwardOf,
  RECIPIENT_PROOF_TYP,
  SIGNED,
  TEST_CONFIG,
  agent,
  memoryStore,
  packAnonymous,
  packSigned,
  peer4Agent,
  plaintext,
  signedBy,
  type Peer4Agent,
} from "./helpers.js";

const PROTOCOL = "https://estoc.dev/replica-mediation/1.0";
const REGISTER = `${PROTOCOL}/register`;
const REGISTERED = `${PROTOCOL}/registered`;
const LIST = `${PROTOCOL}/list`;
const REPLICAS = `${PROTOCOL}/replicas`;
const REMOVE = `${PROTOCOL}/remove`;
const REMOVED = `${PROTOCOL}/removed`;
const RECIPIENT_UPDATE = `${PROTOCOL}/recipient-update`;
const RECIPIENT_UPDATED = `${PROTOCOL}/recipient-updated`;
const RECIPIENT_QUERY = `${PROTOCOL}/recipient-query`;
const RECIPIENTS = `${PROTOCOL}/recipients`;
const PROBLEM = "https://didcomm.org/report-problem/2.0/problem-report";
const MEDIATE_REQUEST = "https://didcomm.org/coordinate-mediation/3.0/mediate-request";
const MEDIATE_GRANT = "https://didcomm.org/coordinate-mediation/3.0/mediate-grant";
const MEDIATE_DENY = "https://didcomm.org/coordinate-mediation/3.0/mediate-deny";
const KEYLIST_UPDATE = "https://didcomm.org/coordinate-mediation/3.0/recipient-update";

const problem = (suffix: string) => `e.estoc.replica-mediation.${suffix}`;

let app: Hono;
let store: SqliteStore;
let mediator: MediatorIdentity;
let account: Peer4Agent;
let mediationId: string;

function uuidv7(): string {
  const hex = randomUUID().replaceAll("-", "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function serve(config: Partial<MediatorConfig> = {}): Hono {
  return buildServer({ identity: mediator, store, config: { ...TEST_CONFIG, ...config } }).app;
}

beforeEach(async () => {
  mediator = await mintIdentity(TEST_CONFIG.publicUrl, "peer2");
  store = memoryStore();
  app = serve();
  account = await peer4Agent(null);
  mediationId = uuidv7();
});

interface Speaker {
  did: string;
  ctx: DIDCommContext;
}

const firstContact = (who: Peer4Agent): Speaker => ({ did: who.longForm, ctx: who.ctx });
const known = (who: Peer4Agent): Speaker => ({ did: who.did, ctx: who.shortCtx });

async function send(
  speaker: Speaker,
  type: string,
  body: Record<string, unknown>,
  overrides: Partial<IMessage> = {},
  to: Hono = app
): Promise<IMessage | null> {
  const message = plaintext(type, body, {
    from: speaker.did,
    to: [mediator.did],
    return_route: "all",
    ...overrides,
  });
  const packed = await speaker.ctx.packEncrypted(message, message.to![0]);
  const res = await to.request("/", {
    method: "POST",
    headers: { "content-type": ENCRYPTED },
    body: packed,
  });
  if (res.status !== 200) {
    return null;
  }
  return (await speaker.ctx.unpack(await res.text())).message;
}

interface Enrollment {
  replica: Peer4Agent;
  replicaId: string;
  payload: Record<string, string>;
  grant: string;
}

async function enrollment(
  of: Peer4Agent = account,
  changes: Record<string, string> = {},
  mediatorDid: string = mediator.did
): Promise<Enrollment> {
  const replica = await peer4Agent(mediatorDid);
  const replicaId = uuidv7();
  const payload = {
    account: of.did,
    mediation_id: mediationId,
    mediator: mediatorDid,
    replica_id: replicaId,
    replica_did: replica.did,
    replica_long_form: replica.longForm,
    ...changes,
  };
  return { replica, replicaId, payload, grant: await signedBy(of, payload) };
}

/** A long form in shape only: `short` followed by a document it does not commit to. */
async function mismatchedLongForm(short: string): Promise<string> {
  const other = (await peer4Agent(null)).longForm;
  return `${short}${other.slice(other.lastIndexOf(":"))}`;
}

const MAX_LONG_FORM_BYTES = 8192;

/** A sound did:peer:4 whose document carries `padding` characters nothing reads. */
function paddedAgent(service: string | null, padding: number): Promise<Peer4Agent> {
  return peer4Agent(service, (document) => ({ ...document, padding: "x".repeat(padding) }));
}

async function register(grant: string, speaker: Speaker = firstContact(account)) {
  return send(speaker, REGISTER, { grant });
}

async function roster(speaker: Speaker = known(account), limit = 2, cursor: string | null = null) {
  return send(speaker, LIST, { cursor, limit });
}

async function expectProblem(reply: IMessage | null, suffix: string) {
  expect(reply?.type).toBe(PROBLEM);
  expect(reply?.body.code).toBe(problem(suffix));
}

describe("register", () => {
  it("creates the account and its first replica with no mediation grant before it", async () => {
    const first = await enrollment();
    const reply = await register(first.grant);

    expect(reply?.type).toBe(REGISTERED);
    expect(reply?.body).toEqual({
      account: account.did,
      mediation_id: mediationId,
      routing_did: mediator.did,
      replica_id: first.replicaId,
      replica_did: first.replica.did,
      state: "active",
      registered_time: expect.any(Number),
      limits: {
        message_retention_seconds: TEST_CONFIG.messageTtlSeconds,
        max_message_bytes: TEST_CONFIG.maxMessageBytes,
        max_active_replicas: TEST_CONFIG.maxActiveReplicas,
        max_membership_page: TEST_CONFIG.maxMembershipPage,
        max_shared_recipients: TEST_CONFIG.maxSharedRecipients,
        max_recipient_updates: 16,
        max_retained_bytes: TEST_CONFIG.maxRetainedBytes,
        max_retained_messages: TEST_CONFIG.maxMessagesPerAccount,
        max_deliveries_per_request: 10,
      },
    });
    expect(await store.isMediated(account.did)).toBe(false);
    expect(await store.isMediated(account.longForm)).toBe(false);
  });

  it("answers a repeat with the first registration, in either spelling of the account", async () => {
    const first = await enrollment();
    const original = await register(first.grant);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const retried = await register(first.grant);
    const later = await register(first.grant, known(account));

    expect(retried?.body).toEqual(original?.body);
    expect(later?.body).toEqual(original?.body);
    expect((await roster())?.body.entries).toHaveLength(1);
  });

  it("enrolls a further replica in the account it already has", async () => {
    const first = await enrollment();
    const second = await enrollment();
    await register(first.grant);

    const reply = await register(second.grant, known(account));

    expect(reply?.type).toBe(REGISTERED);
    expect(reply?.body.replica_did).toBe(second.replica.did);
    expect((await roster())?.body.entries).toEqual([
      {
        grant: first.grant,
        state: "active",
        registered_time: expect.any(Number),
        removed_time: null,
      },
      {
        grant: second.grant,
        state: "active",
        registered_time: expect.any(Number),
        removed_time: null,
      },
    ]);
  });

  it("enrolls a replica whose keys are spelled as JWKs", async () => {
    const replica = await peer4Agent(mediator.did, (document) => ({
      ...document,
      verificationMethod: document.verificationMethod!.map((method) => ({
        id: method.id,
        type: "JsonWebKey2020",
        publicKeyJwk: {
          kty: "OKP",
          crv: method.id === "#key-1" ? "Ed25519" : "X25519",
          x: bytesToBase64url(bs58.decode((method.publicKeyMultibase as string).slice(1)).slice(2)),
        },
      })),
    }));
    const { grant } = await enrollment(account, {
      replica_did: replica.did,
      replica_long_form: replica.longForm,
    });
    expect((await register(grant))?.type).toBe(REGISTERED);
  });

  it("gives two first registrations racing for one account the same account", async () => {
    const [first, second] = await Promise.all([enrollment(), enrollment()]);

    const replies = await Promise.all([register(first.grant), register(second.grant)]);

    expect(replies.map((reply) => reply?.type)).toEqual([REGISTERED, REGISTERED]);
    expect((await roster())?.body.entries).toHaveLength(2);
  });

  it("keeps the long forms, so the account and its replicas resolve by their short ones", async () => {
    const first = await enrollment();
    await register(first.grant);

    expect(await store.resolutionMaterial(account.did)).toBe(account.longForm);
    expect(await store.resolutionMaterial(first.replica.did)).toBe(first.replica.longForm);
  });

  it("refuses an unknown account that does not introduce itself by its long form", async () => {
    const first = await enrollment();
    expect(await register(first.grant, known(account))).toBeNull();
    await expectProblem(await roster(firstContact(account)), "unknown-account");
  });

  it("says nothing to a sender it cannot name", async () => {
    const first = await enrollment();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": ENCRYPTED },
      body: await packAnonymous(plaintext(REGISTER, { grant: first.grant }), mediator.did),
    });
    expect(res.status).toBe(202);
    await expectProblem(await roster(firstContact(account)), "unknown-account");
  });

  describe("refuses a grant", () => {
    async function refused(grant: string, speaker: Speaker = firstContact(account)) {
      await expectProblem(await register(grant, speaker), "invalid-grant");
      await expectProblem(await roster(firstContact(account)), "unknown-account");
    }

    it("the account did not sign", async () => {
      const { replica, payload } = await enrollment();
      await refused(await signedBy(replica, payload, { kid: `${account.did}#key-1` }));
      await refused(await signedBy(replica, payload));
    });

    it("whose key ID spells the account as a long form of another document", async () => {
      const { payload } = await enrollment();
      await refused(await signedBy(account, payload, { kid: `${await mismatchedLongForm(account.did)}#key-1` }));
    });

    it("signed for another account", async () => {
      const other = await peer4Agent(null);
      const { grant } = await enrollment(other);
      await refused(grant);
    });

    it("sent by the replica it names", async () => {
      const { replica, grant } = await enrollment();
      await refused(grant, firstContact(replica));
    });

    it("naming another mediator", async () => {
      const { grant } = await enrollment(account, { mediator: "did:web:elsewhere.test" });
      await refused(grant);
    });

    it("whose replica document is served by another mediator", async () => {
      const elsewhere = await peer4Agent("did:web:elsewhere.test");
      const { grant } = await enrollment(account, {
        replica_did: elsewhere.did,
        replica_long_form: elsewhere.longForm,
      });
      await refused(grant);
    });

    it("whose long form is not the replica DID's", async () => {
      const other = await peer4Agent(mediator.did);
      const { grant } = await enrollment(account, { replica_long_form: other.longForm });
      await refused(grant);
    });

    it("naming the account as its own replica", async () => {
      const selfServed = await peer4Agent(mediator.did);
      const { grant } = await enrollment(selfServed, {
        replica_did: selfServed.did,
        replica_long_form: selfServed.longForm,
      });
      await expectProblem(await register(grant, firstContact(selfServed)), "invalid-grant");
    });

    it("whose replica has no key to sign in with, or none to be sealed to", async () => {
      const shapes: ((document: Record<string, unknown>) => Record<string, unknown>)[] = [
        ({ verificationMethod: _, authentication: __, keyAgreement: ___, ...rest }) => rest,
        (document) => ({ ...document, authentication: [] }),
        (document) => ({ ...document, keyAgreement: [] }),
        (document) => ({ ...document, authentication: ["#key-2"] }),
        (document) => ({ ...document, keyAgreement: ["#key-1"] }),
      ];
      for (const shape of shapes) {
        const replica = await peer4Agent(mediator.did, shape as never);
        const { grant } = await enrollment(account, {
          replica_did: replica.did,
          replica_long_form: replica.longForm,
        });
        await refused(grant);
      }
    });

    it("whose replica holds its key under a type DIDComm cannot use", async () => {
      for (const type of ["UnrecognizedKeyType", "Ed25519VerificationKey2020"]) {
        const replica = await peer4Agent(mediator.did, (document) => ({
          ...document,
          verificationMethod: document.verificationMethod!.map((method) =>
            method.id === "#key-2" ? { ...method, type } : method
          ),
        }));
        const { grant } = await enrollment(account, {
          replica_did: replica.did,
          replica_long_form: replica.longForm,
        });
        await refused(grant);
      }
    });

    it("whose mediator, as named or as the replica's service, is a long form of another document", async () => {
      mediator = await mintIdentity(TEST_CONFIG.publicUrl, ["peer4"]);
      app = serve();
      const short = longToShort(mediator.did);
      const mismatched = await mismatchedLongForm(short);

      const [named, served] = [
        await enrollment(account, { mediator: mismatched }, short),
        await enrollment(account, { mediator: short }, mismatched),
      ];
      await refused(named.grant);
      await refused(served.grant);
    });

    it("whose replica has a long form too large to decode", async () => {
      const replica = await paddedAgent(mediator.did, 5600);
      const { payload } = await enrollment();
      expect(replica.longForm.length).toBeGreaterThan(MAX_LONG_FORM_BYTES);

      await refused(
        await signedBy(account, {
          ...payload,
          replica_did: replica.did,
          replica_long_form: replica.longForm,
        })
      );
    });

    it("with IDs that are not UUIDv7", async () => {
      await refused((await enrollment(account, { replica_id: randomUUID() })).grant);
      await refused((await enrollment(account, { mediation_id: "1" })).grant);
    });

    it("with a field too many, a field too few, or another spelling of its JSON", async () => {
      const { payload } = await enrollment();
      const { mediator: _, ...short } = payload;
      await refused(await signedBy(account, { ...payload, iat: "1" }));
      await refused(await signedBy(account, short));

      const spaced = new TextEncoder().encode(JSON.stringify(payload, null, 1));
      await refused(
        await new CompactSign(spaced)
          .setProtectedHeader({
            alg: "EdDSA",
            typ: "estoc/replica-grant+jws",
            kid: `${account.did}#key-1`,
          })
          .sign(await importJWK(account.signingKey, "EdDSA"))
      );
    });

    it("whose signed bytes open with a byte-order mark", async () => {
      const { payload } = await enrollment();
      await refused(
        await new CompactSign(new TextEncoder().encode(`\ufeff${canonicalize(payload)}`))
          .setProtectedHeader({
            alg: "EdDSA",
            typ: "estoc/replica-grant+jws",
            kid: `${account.did}#key-1`,
          })
          .sign(await importJWK(account.signingKey, "EdDSA"))
      );
    });

    it("of another type, or carrying where to fetch a key", async () => {
      const { payload } = await enrollment();
      await refused(await signedBy(account, payload, { typ: "JWT" }));
      await refused(await signedBy(account, payload, { jku: "https://keys.test/set" }));
      await refused(await signedBy(account, payload, { kid: `${account.did}#key-2` }));
    });

    it("whose payload was changed after signing", async () => {
      const { grant, payload } = await enrollment();
      const [header, , signature] = grant.split(".");
      const altered = Buffer.from(
        JSON.stringify({ ...payload, replica_id: uuidv7() })
      ).toString("base64url");
      await refused(`${header}.${altered}.${signature}`);
    });
  });

  it("takes the account's key ID in its long form", async () => {
    const { payload } = await enrollment();
    const grant = await signedBy(account, payload, { kid: `${account.longForm}#key-1` });
    expect((await register(grant))?.type).toBe(REGISTERED);
  });

  it("refuses a request that names its sender as a long form of another document", async () => {
    const { grant } = await enrollment();
    const claimed = await mismatchedLongForm(account.did);
    await expectProblem(
      await send({ did: claimed, ctx: account.claiming(claimed) }, REGISTER, { grant }),
      "invalid-message"
    );
    await expectProblem(await roster(firstContact(account)), "unknown-account");
  });

  it("refuses a request whose body or addressing is not exactly a registration", async () => {
    const { grant } = await enrollment();
    const speaker = firstContact(account);
    const other = await agent("other");

    await expectProblem(await send(speaker, REGISTER, { grant, replica_id: "x" }), "invalid-message");
    await expectProblem(await send(speaker, REGISTER, {}), "invalid-message");
    await expectProblem(
      await send(speaker, REGISTER, { grant }, { to: [mediator.did, other.did] }),
      "invalid-message"
    );
    await expectProblem(await roster(firstContact(account)), "unknown-account");
  });

  describe("refuses a conflicting identity without changing anything", () => {
    it("a replica ID bound to another DID, or a DID under another ID", async () => {
      const first = await enrollment();
      await register(first.grant);

      const sameId = await enrollment(account, { replica_id: first.replicaId });
      const sameDid = await enrollment(account, {
        replica_did: first.replica.did,
        replica_long_form: first.replica.longForm,
      });

      await expectProblem(await register(sameId.grant), "identity-conflict");
      await expectProblem(await register(sameDid.grant), "identity-conflict");
      expect((await roster())?.body.entries).toHaveLength(1);
    });

    it("another mediation ID for the account", async () => {
      await register((await enrollment()).grant);
      const moved = await enrollment(account, { mediation_id: uuidv7() });

      await expectProblem(await register(moved.grant), "identity-conflict");
      expect((await roster())?.body.entries).toHaveLength(1);
    });

    it("a replica another account enrolled, or another account itself", async () => {
      const first = await enrollment();
      await register(first.grant);
      const other = await peer4Agent(null);

      const taken = await enrollment(other, {
        replica_did: first.replica.did,
        replica_long_form: first.replica.longForm,
      });
      await expectProblem(await register(taken.grant, firstContact(other)), "identity-conflict");
      await expectProblem(await roster(firstContact(other)), "unknown-account");

      const selfServed = await peer4Agent(mediator.did);
      await register((await enrollment(selfServed)).grant, firstContact(selfServed));
      const asReplica = await enrollment(account, {
        replica_did: selfServed.did,
        replica_long_form: selfServed.longForm,
      });
      await expectProblem(await register(asReplica.grant), "identity-conflict");
    });

    it("an account or a replica that holds ordinary mediation", async () => {
      const ordinary = await send(firstContact(account), MEDIATE_REQUEST, {});
      expect(ordinary?.type).toBe(MEDIATE_GRANT);
      await expectProblem(await register((await enrollment()).grant), "identity-conflict");

      const other = await peer4Agent(null);
      const mediated = await enrollment(other);
      await send(firstContact(mediated.replica), MEDIATE_REQUEST, {});
      await expectProblem(await register(mediated.grant, firstContact(other)), "identity-conflict");
      await expectProblem(await roster(firstContact(other)), "unknown-account");
    });

    it("a replica that is an ordinary account's recipient", async () => {
      const holder = await agent("holder");
      const bound = await enrollment();
      await send(holder, MEDIATE_REQUEST, {});
      await send(holder, KEYLIST_UPDATE, {
        updates: [{ recipient_did: bound.replica.did, action: "add" }],
      });

      await expectProblem(await register(bound.grant), "identity-conflict");
      await expectProblem(await roster(firstContact(account)), "unknown-account");
    });
  });

  it("stops enrolling at the replica limit and still answers the ones it has", async () => {
    const enrolled = [];
    for (let i = 0; i < TEST_CONFIG.maxActiveReplicas; i++) {
      enrolled.push(await enrollment());
      expect((await register(enrolled[i].grant))?.type).toBe(REGISTERED);
    }

    await expectProblem(await register((await enrollment()).grant), "quota");
    expect((await register(enrolled[0].grant))?.type).toBe(REGISTERED);
  });

  it("leaves no account behind where the replica limit admits none", async () => {
    const none = serve({ maxActiveReplicas: 0 });
    const { grant } = await enrollment();

    await expectProblem(await send(firstContact(account), REGISTER, { grant }, {}, none), "quota");
    expect(await store.isReplicaAccount(account.did)).toBe(false);
    expect(await store.resolutionMaterial(account.did)).toBeNull();
  });

  it("creates no account where registration is closed", async () => {
    const closed = serve({ openRegistration: false });
    const { grant } = await enrollment();

    await expectProblem(
      await send(firstContact(account), REGISTER, { grant }, {}, closed),
      "account-refused"
    );
    await expectProblem(await roster(firstContact(account)), "unknown-account");
  });

  it("is an unsupported type where replica mediation is off", async () => {
    const off = serve({ replicaMediation: false });
    const { grant } = await enrollment();

    const reply = await send(firstContact(account), REGISTER, { grant }, {}, off);
    expect(reply?.body.code).toBe("e.p.msg.unsupported");

    const described = (await (await off.request("/")).json()) as { protocols: string[] };
    expect(described.protocols).not.toContain(PROTOCOL);
    expect(((await (await app.request("/")).json()) as { protocols: string[] }).protocols).toContain(
      PROTOCOL
    );
  });
});

describe("a reply to a control", () => {
  it("carries the request's own ID as its thread, whatever thread the request sat in", async () => {
    const { grant } = await enrollment();
    const asked = { id: randomUUID(), thid: "an-older-exchange" };

    const registered = await send(firstContact(account), REGISTER, { grant }, asked);
    expect(registered?.type).toBe(REGISTERED);
    expect(registered?.thid).toBe(asked.id);

    const listed = await send(known(account), LIST, { cursor: null, limit: 2 }, asked);
    expect(listed?.type).toBe(REPLICAS);
    expect(listed?.thid).toBe(asked.id);

    const refused = await send(known(account), LIST, { cursor: null, limit: 0 }, asked);
    await expectProblem(refused, "invalid-message");
    expect(refused?.thid).toBe(asked.id);
    expect(refused?.pthid).toBe(asked.id);
  });
});

describe("the mediator an account is bound to", () => {
  it("is one did:peer:4 in either spelling, in the grant and in the replica's service", async () => {
    mediator = await mintIdentity(TEST_CONFIG.publicUrl, ["peer4"]);
    app = serve();
    const short = longToShort(mediator.did);

    const spelled = [
      await enrollment(account, {}, short),
      await enrollment(account, {}, mediator.did),
    ];
    const [underShort, underLong] = [
      await register(spelled[0].grant),
      await send(known(account), REGISTER, { grant: spelled[1].grant }),
    ];
    expect(underShort?.type).toBe(REGISTERED);
    expect(underShort?.body.routing_did).toBe(mediator.did);
    expect(underLong?.type).toBe(REGISTERED);
    expect((await roster())?.body.entries).toHaveLength(2);
  });

  it("is not another name the same deployment answers to", async () => {
    mediator = await mintIdentity(TEST_CONFIG.publicUrl, ["peer2", "peer4"]);
    app = serve();
    const alias = mediator.aliases[0].did;
    expect((await register((await enrollment()).grant))?.type).toBe(REGISTERED);

    const underAlias = await enrollment(account, {}, alias);
    await expectProblem(
      await send(known(account), REGISTER, { grant: underAlias.grant }, { to: [alias] }),
      "identity-conflict"
    );
    await expectProblem(
      await send(known(account), LIST, { cursor: null, limit: 2 }, { to: [alias] }),
      "unknown-account"
    );
    expect((await roster())?.body.entries).toHaveLength(1);
  });
});

describe("the replica limits a deployment sets", () => {
  it("are positive integers, or the mediator does not start", () => {
    const set = (value: string) => () =>
      replicaPolicyFrom((name) => (name === "MEDIATOR_MAX_ACTIVE_REPLICAS" ? value : undefined));

    for (const value of ["0", "-1", "1.5", "many"]) {
      expect(set(value)).toThrow("MEDIATOR_MAX_ACTIVE_REPLICAS");
    }
    expect(set("4")().maxActiveReplicas).toBe(4);
  });
});

describe("list", () => {
  it("pages one fixed roster, oldest first, whoever enrolls meanwhile", async () => {
    const grants = [];
    for (let i = 0; i < 2; i++) {
      grants.push((await enrollment()).grant);
      await register(grants[i]);
    }

    const first = await roster(known(account), 1);
    expect(first?.type).toBe(REPLICAS);
    expect((first?.body.entries as { grant: string }[]).map((entry) => entry.grant)).toEqual([
      grants[0],
    ]);

    await register((await enrollment()).grant);

    const second = await roster(known(account), 2, first?.body.next_cursor as string);
    expect((second?.body.entries as { grant: string }[]).map((entry) => entry.grant)).toEqual([
      grants[1],
    ]);
    expect(second?.body.next_cursor).toBeNull();

    const again = await roster(known(account), 2, first?.body.next_cursor as string);
    expect(again?.body).toEqual(second?.body);
    expect((await roster())?.body.next_cursor).not.toBeNull();
  });

  it("refuses a limit past the page size, a cursor it did not write, and another account's", async () => {
    await register((await enrollment()).grant);
    await register((await enrollment()).grant);
    const other = await peer4Agent(null);
    await register((await enrollment(other)).grant, firstContact(other));
    await register((await enrollment(other)).grant, firstContact(other));
    const foreign = (await roster(known(other), 1))?.body.next_cursor as string;
    expect(foreign).toEqual(expect.any(String));

    await expectProblem(await roster(known(account), 3), "invalid-message");
    await expectProblem(await roster(known(account), 0), "invalid-message");
    await expectProblem(await roster(known(account), 1, "bm9uc2Vuc2U"), "invalid-message");
    await expectProblem(await roster(known(account), 1, foreign), "invalid-message");
    await expectProblem(await send(known(account), LIST, { limit: 1 }), "invalid-message");
  });

  it("discloses nothing of an account to a replica of it", async () => {
    const first = await enrollment();
    await register(first.grant);

    await expectProblem(await roster(known(first.replica)), "unknown-account");
  });
});

interface Addition {
  recipient: Peer4Agent;
  payload: Record<string, string>;
  proof: string;
}

async function addition(
  of: Peer4Agent = account,
  changes: Record<string, string> = {}
): Promise<Addition> {
  const recipient = await peer4Agent(mediator.did);
  const payload = { account: of.did, aud: mediator.did, recipient: recipient.did, ...changes };
  return { recipient, payload, proof: await proofBy(recipient, payload) };
}

function proofBy(signer: Peer4Agent, payload: unknown, header: Record<string, unknown> = {}) {
  return signedBy(signer, payload, { typ: RECIPIENT_PROOF_TYP, ...header });
}

function adding(
  { recipient, proof }: Pick<Addition, "recipient" | "proof">,
  changes: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    recipient_did: recipient.did,
    action: "add",
    resolution_material: recipient.longForm,
    proof,
    ...changes,
  };
}

const removing = (recipient: Peer4Agent): Record<string, unknown> => ({
  recipient_did: recipient.did,
  action: "remove",
});

async function update(updates: unknown, speaker: Speaker = known(account)) {
  return send(speaker, RECIPIENT_UPDATE, { updates });
}

async function add(
  added: Pick<Addition, "recipient" | "proof">,
  speaker: Speaker = known(account),
  changes: Record<string, unknown> = {}
) {
  return update([adding(added, changes)], speaker);
}

interface Updated {
  recipient_did: string;
  action: string;
  result: string;
  problem?: string;
}

const updated = (reply: IMessage | null) => (reply?.body.updated ?? []) as Updated[];
const result = (reply: IMessage | null) => updated(reply)[0]?.result;

function expectRefusedUpdate(reply: IMessage | null, suffix: string) {
  expect(reply?.type).toBe(RECIPIENT_UPDATED);
  expect(updated(reply)).toEqual([
    expect.objectContaining({ result: "client_error", problem: problem(suffix) }),
  ]);
}

async function recipients(speaker: Speaker = known(account), limit = 2, offset = 0) {
  return send(speaker, RECIPIENT_QUERY, { paginate: { limit, offset } });
}

describe("recipient-update", () => {
  let enrolled: Enrollment[];

  beforeEach(async () => {
    enrolled = [await enrollment()];
    await register(enrolled[0].grant);
  });

  it("binds a communication DID its controller signed over to the account", async () => {
    const first = await addition();
    const reply = await add(first);

    expect(reply?.type).toBe(RECIPIENT_UPDATED);
    expect(reply?.body).toEqual({
      updated: [{ recipient_did: first.recipient.did, action: "add", result: "success" }],
    });
    expect(await store.sharedRecipientMaterial(first.recipient.did)).toBe(first.recipient.longForm);
  });

  it("answers a repeat with no change, under a new request ID and the same proof", async () => {
    const first = await addition();
    await add(first);
    const asked = { id: randomUUID() };

    const reply = await send(
      known(account),
      RECIPIENT_UPDATE,
      { updates: [adding(first, { resolution_material: null })] },
      asked
    );

    expect(updated(reply)).toEqual([
      { recipient_did: first.recipient.did, action: "add", result: "no_change" },
    ]);
    expect(reply?.thid).toBe(asked.id);
  });

  it("takes the recipient, the account and the mediator in either spelling", async () => {
    mediator = await mintIdentity(TEST_CONFIG.publicUrl, ["peer4"]);
    app = serve();
    account = await peer4Agent(null);
    expect((await register((await enrollment()).grant))?.type).toBe(REGISTERED);
    const recipient = await peer4Agent(mediator.did);
    const proof = await proofBy(
      recipient,
      { account: account.longForm, aud: longToShort(mediator.did), recipient: recipient.longForm },
      { kid: `${recipient.longForm}#key-1` }
    );

    const reply = await add({ recipient, proof }, known(account), {
      recipient_did: recipient.longForm,
    });

    expect(updated(reply)).toEqual([
      { recipient_did: recipient.did, action: "add", result: "success" },
    ]);
  });

  it("takes a recipient whose long form is large but within the limit", async () => {
    const recipient = await paddedAgent(mediator.did, 5000);
    const proof = await proofBy(recipient, {
      account: account.did,
      aud: mediator.did,
      recipient: recipient.did,
    });
    expect(recipient.longForm.length).toBeGreaterThan(MAX_LONG_FORM_BYTES - 1024);
    expect(recipient.longForm.length).toBeLessThanOrEqual(MAX_LONG_FORM_BYTES);

    expect(result(await add({ recipient, proof }))).toBe("success");
  });

  it("gives two adds racing for one recipient a single binding", async () => {
    const first = await addition();

    const replies = await Promise.all([add(first), add(first)]);

    expect(replies.map(result).sort()).toEqual(["no_change", "success"]);
  });

  describe("refuses a recipient", () => {
    async function refused(reply: IMessage | null, recipient: Peer4Agent) {
      expectRefusedUpdate(reply, "invalid-recipient");
      expect(await store.sharedRecipientMaterial(recipient.did)).toBeNull();
    }

    it("whose proof the account signed, or another DID did", async () => {
      const { recipient, payload } = await addition();
      const other = await peer4Agent(null);

      await refused(await add({ recipient, proof: await proofBy(account, payload) }), recipient);
      await refused(
        await add({
          recipient,
          proof: await proofBy(account, payload, { kid: `${recipient.did}#key-1` }),
        }),
        recipient
      );
      await refused(await add({ recipient, proof: await proofBy(other, payload) }), recipient);
      await refused(await add({ recipient, proof: "" }), recipient);
    });

    it("whose proof names another account, mediator or recipient", async () => {
      const other = await peer4Agent(null);
      await register((await enrollment(other)).grant, firstContact(other));
      const elsewhere = await addition();

      for (const changes of [
        { account: other.did },
        { aud: "did:web:elsewhere.test" },
        { recipient: elsewhere.recipient.did },
      ]) {
        const { recipient, proof } = await addition(account, changes);
        await refused(await add({ recipient, proof }), recipient);
      }
    });

    it("whose proof was changed after signing, or is a replica grant", async () => {
      const { recipient, payload, proof } = await addition();
      const other = await peer4Agent(null);
      const [header, , signature] = proof.split(".");
      const altered = Buffer.from(canonicalize({ ...payload, account: other.did })!).toString(
        "base64url"
      );

      await refused(await add({ recipient, proof: `${header}.${altered}.${signature}` }), recipient);
      await refused(await add({ recipient, proof: await signedBy(recipient, payload) }), recipient);
      await refused(
        await add({ recipient, proof: await proofBy(recipient, { ...payload, iat: "1" }) }),
        recipient
      );
    });

    it("it has no resolution material for", async () => {
      const first = await addition();
      const other = await peer4Agent(null);

      await refused(await add(first, known(account), { resolution_material: null }), first.recipient);
      await refused(
        await add(first, known(account), { resolution_material: other.longForm }),
        first.recipient
      );
      await refused(
        await add(first, known(account), {
          resolution_material: await mismatchedLongForm(first.recipient.did),
        }),
        first.recipient
      );
    });

    it("whose long form is too large to decode, however sound its proof", async () => {
      const recipient = await paddedAgent(mediator.did, 5600);
      const payload = { account: account.did, aud: mediator.did, recipient: recipient.did };
      const proof = await proofBy(recipient, payload);
      expect(recipient.longForm.length).toBeGreaterThan(MAX_LONG_FORM_BYTES);

      await refused(await add({ recipient, proof }), recipient);
      await refused(
        await add({ recipient, proof }, known(account), {
          recipient_did: recipient.longForm,
          resolution_material: null,
        }),
        recipient
      );
    });

    it("that is not a did:peer:4", async () => {
      const stranger = await agent("stranger");
      const { recipient, proof } = await addition();

      expectRefusedUpdate(
        await add({ recipient, proof }, known(account), {
          recipient_did: stranger.did,
          resolution_material: null,
        }),
        "invalid-recipient"
      );
    });

    it("it already holds, when the proof does not stand", async () => {
      const first = await addition();
      await add(first);

      expectRefusedUpdate(
        await add({ recipient: first.recipient, proof: await proofBy(account, first.payload) }),
        "invalid-recipient"
      );
    });
  });

  it("refuses the whole request when an update is not exactly an addition or a removal", async () => {
    const first = await addition();
    const sound = adding(first);
    const { action: _, ...unnamed } = sound;
    const { resolution_material: __, ...unresolved } = sound;

    for (const updates of [
      [],
      sound,
      [sound, unnamed],
      [sound, unresolved],
      [sound, { ...sound, action: "replace" }],
      [sound, { ...sound, resolution_material: 1 }],
      [sound, { ...sound, proof: null }],
      [sound, { ...sound, recipient_did: [first.recipient.did] }],
      [sound, { ...removing(first.recipient), proof: first.proof }],
      [sound, { ...removing(first.recipient), recipient_did: 1 }],
      [sound, null],
    ]) {
      await expectProblem(await update(updates), "invalid-message");
    }
    await expectProblem(
      await send(known(account), RECIPIENT_UPDATE, { updates: [sound], paginate: null }),
      "invalid-message"
    );
    expect(await store.sharedRecipientMaterial(first.recipient.did)).toBeNull();
  });

  it("takes no more updates in one request than it says it will", async () => {
    const first = await addition();
    const { limits } = (await register((await enrollment()).grant))!.body as {
      limits: { max_recipient_updates: number };
    };

    const full = Array.from({ length: limits.max_recipient_updates }, () => removing(first.recipient));
    expect(updated(await update(full))).toHaveLength(limits.max_recipient_updates);
    await expectProblem(await update([...full, adding(first)]), "invalid-message");
    expect(await store.sharedRecipientMaterial(first.recipient.did)).toBeNull();
  });

  it("answers each update in its place, a refused one undoing none of the others", async () => {
    const [first, second, third] = [await addition(), await addition(), await addition()];
    await add(first);
    const forged = { recipient: second.recipient, proof: await proofBy(account, second.payload) };

    const reply = await update([
      adding(third),
      adding(forged),
      removing(first.recipient),
      removing(second.recipient),
      adding(third, { resolution_material: null }),
    ]);

    expect(reply?.body).toEqual({
      updated: [
        { recipient_did: third.recipient.did, action: "add", result: "success" },
        {
          recipient_did: second.recipient.did,
          action: "add",
          result: "client_error",
          problem: problem("invalid-recipient"),
        },
        { recipient_did: first.recipient.did, action: "remove", result: "success" },
        { recipient_did: second.recipient.did, action: "remove", result: "no_change" },
        { recipient_did: third.recipient.did, action: "add", result: "no_change" },
      ],
    });
  });

  it("needs an account that already exists, at the mediator it is bound to", async () => {
    const stranger = await peer4Agent(null);
    const unknown = await addition(stranger);
    await expectProblem(await add(unknown, firstContact(stranger)), "unknown-account");
    expect(await store.sharedRecipientMaterial(unknown.recipient.did)).toBeNull();

    mediator = await mintIdentity(TEST_CONFIG.publicUrl, ["peer2", "peer4"]);
    app = serve();
    account = await peer4Agent(null);
    expect((await register((await enrollment()).grant))?.type).toBe(REGISTERED);
    const alias = mediator.aliases[0].did;
    const underAlias = await addition(account, { aud: alias });
    await expectProblem(
      await send(
        known(account),
        RECIPIENT_UPDATE,
        { updates: [adding(underAlias), removing(underAlias.recipient)] },
        { to: [alias] }
      ),
      "unknown-account"
    );
    expect(await store.sharedRecipientMaterial(underAlias.recipient.did)).toBeNull();
    expect(result(await add(await addition()))).toBe("success");
  });

  describe("refuses a DID that is bound otherwise, without changing anything", () => {
    it("another account's recipient", async () => {
      const other = await peer4Agent(null);
      await register((await enrollment(other)).grant, firstContact(other));
      const first = await addition();
      await add(first);

      const claim = {
        recipient: first.recipient,
        proof: await proofBy(first.recipient, { ...first.payload, account: other.did }),
      };
      expectRefusedUpdate(await add(claim, known(other)), "identity-conflict");
      expect(result(await add(first))).toBe("no_change");
    });

    it("a replica, or an account, its own included", async () => {
      const member = await enrollment();
      await register(member.grant);
      const other = await peer4Agent(null);
      await register((await enrollment(other)).grant, firstContact(other));

      for (const bound of [member.replica, account, other]) {
        const proof = await proofBy(bound, {
          account: account.did,
          aud: mediator.did,
          recipient: bound.did,
        });
        expectRefusedUpdate(await add({ recipient: bound, proof }), "identity-conflict");
        expect(await store.sharedRecipientMaterial(bound.did)).toBeNull();
      }
    });

    it("an ordinary account, or an ordinary account's recipient, under either spelling", async () => {
      const holder = await agent("holder");
      await send(holder, MEDIATE_REQUEST, {});
      const [mediated, listedShort, listedLong] = [
        await addition(),
        await addition(),
        await addition(),
      ];
      await send(firstContact(mediated.recipient), MEDIATE_REQUEST, {});
      await send(holder, KEYLIST_UPDATE, {
        updates: [listedShort.recipient.did, listedLong.recipient.longForm].map((recipient_did) => ({
          recipient_did,
          action: "add",
        })),
      });

      for (const bound of [mediated, listedShort, listedLong]) {
        expectRefusedUpdate(await add(bound), "identity-conflict");
        expect(await store.sharedRecipientMaterial(bound.recipient.did)).toBeNull();
      }
    });
  });

  it("keeps a recipient from every other binding", async () => {
    const first = await addition();
    await add(first);
    const { recipient } = first;
    const holder = await agent("holder");
    await send(holder, MEDIATE_REQUEST, {});

    expect((await send(firstContact(recipient), MEDIATE_REQUEST, {}))?.type).toBe(MEDIATE_DENY);
    const update = await send(holder, KEYLIST_UPDATE, {
      updates: [recipient.did, recipient.longForm].map((recipient_did) => ({
        recipient_did,
        action: "add",
      })),
    });
    expect((update?.body.updated as { result: string }[]).map(({ result }) => result)).toEqual([
      "client_error",
      "client_error",
    ]);

    const asReplica = await enrollment(account, {
      replica_did: recipient.did,
      replica_long_form: recipient.longForm,
    });
    await expectProblem(await register(asReplica.grant), "identity-conflict");

    const other = await peer4Agent(null);
    const underOther = await enrollment(other, {
      replica_did: recipient.did,
      replica_long_form: recipient.longForm,
    });
    await expectProblem(await register(underOther.grant, firstContact(other)), "identity-conflict");
    await expectProblem(await roster(firstContact(other)), "unknown-account");

    const asAccount = await enrollment(recipient);
    await expectProblem(
      await register(asAccount.grant, firstContact(recipient)),
      "identity-conflict"
    );
    expect((await roster())?.body.entries).toHaveLength(1);
  });

  it("stops adding at the recipient limit and still answers the ones it has", async () => {
    const added = [];
    for (let i = 0; i < TEST_CONFIG.maxSharedRecipients; i++) {
      added.push(await addition());
      expect(result(await add(added[i]))).toBe("success");
    }

    const over = await addition();
    expectRefusedUpdate(await add(over), "quota");
    expect(await store.sharedRecipientMaterial(over.recipient.did)).toBeNull();
    expect(result(await add(added[0]))).toBe("no_change");
  });

  describe("removing a recipient", () => {
    let first: Addition;

    beforeEach(async () => {
      first = await addition();
      await add(first);
    });

    it("unbinds it, in either spelling, and forgets its long form", async () => {
      const reply = await update([
        { recipient_did: first.recipient.longForm, action: "remove" },
      ]);

      expect(reply?.type).toBe(RECIPIENT_UPDATED);
      expect(reply?.body).toEqual({
        updated: [{ recipient_did: first.recipient.did, action: "remove", result: "success" }],
      });
      expect(await store.sharedRecipientMaterial(first.recipient.did)).toBeNull();
      expect((await post(forwardOf(first.recipient.did, await envelope(first.recipient)))).status).toBe(
        422
      );
    });

    it("answers a repeat, or a DID the account never held, with no change", async () => {
      const stranger = await agent("stranger");
      await update([removing(first.recipient)]);

      const reply = await update([
        removing(first.recipient),
        { recipient_did: stranger.did, action: "remove" },
      ]);

      expect(updated(reply).map((answer) => answer.result)).toEqual(["no_change", "no_change"]);
    });

    it("leaves another account's recipient where it is", async () => {
      const other = await peer4Agent(null);
      await register((await enrollment(other)).grant, firstContact(other));

      expect(result(await update([removing(first.recipient)], known(other)))).toBe("no_change");
      expect(result(await add(first))).toBe("no_change");
    });

    it("makes room under the recipient limit", async () => {
      const added = [first];
      while (added.length < TEST_CONFIG.maxSharedRecipients) {
        added.push(await addition());
        await add(added.at(-1)!);
      }
      const over = await addition();
      expectRefusedUpdate(await add(over), "quota");

      await update([removing(first.recipient)]);

      expect(result(await add(over))).toBe("success");
    });

    it("needs its proof and its long form again to be added back", async () => {
      await update([removing(first.recipient)]);

      expectRefusedUpdate(
        await add(first, known(account), { resolution_material: null }),
        "invalid-recipient"
      );
      expect(result(await add(first))).toBe("success");
    });

    it("frees it for another account its controller signs it over to, and for ordinary mediation", async () => {
      const other = await peer4Agent(null);
      await register((await enrollment(other)).grant, firstContact(other));
      const second = await addition();
      await add(second);
      await update([removing(first.recipient), removing(second.recipient)]);

      const moved = {
        recipient: first.recipient,
        proof: await proofBy(first.recipient, { ...first.payload, account: other.did }),
      };
      expect(result(await add(moved, known(other)))).toBe("success");
      expectRefusedUpdate(await add(first), "identity-conflict");
      expect((await send(firstContact(second.recipient), MEDIATE_REQUEST, {}))?.type).toBe(
        MEDIATE_GRANT
      );
    });

    it("keeps the mail already queued for it, which each replica still picks up", async () => {
      const [replica] = enrolled;
      const inner = await envelope(first.recipient);
      await post(forwardOf(first.recipient.did, inner));

      await update([removing(first.recipient)]);

      const reply = await send(known(replica.replica), `${PICKUP}/delivery-request`, { limit: 10 });
      expect((reply?.attachments as Attached[]).map(carried)).toEqual([inner]);
    });
  });
});

describe("recipient-query", () => {
  let added: Addition[];

  beforeEach(async () => {
    await register((await enrollment()).grant);
    added = [await addition(), await addition(), await addition()];
    for (const one of added) {
      await add(one);
    }
  });

  const listed = (reply: IMessage | null) =>
    (reply?.body.dids as { recipient_did: string }[]).map((entry) => entry.recipient_did);

  it("pages the account's recipients, oldest first, by their short forms", async () => {
    const first = await recipients(known(account), 2, 0);
    const second = await recipients(known(account), 2, 2);

    expect(first?.type).toBe(RECIPIENTS);
    expect(first?.body).toEqual({
      dids: added.slice(0, 2).map(({ recipient }) => ({ recipient_did: recipient.did })),
      pagination: { count: 2, offset: 0, remaining: 1 },
    });
    expect(second?.body).toEqual({
      dids: [{ recipient_did: added[2].recipient.did }],
      pagination: { count: 1, offset: 2, remaining: 0 },
    });
  });

  it("answers an offset past the end with an empty page", async () => {
    expect((await recipients(known(account), 2, 7))?.body).toEqual({
      dids: [],
      pagination: { count: 0, offset: 7, remaining: 0 },
    });
  });

  it("no longer lists a removed recipient", async () => {
    await update([removing(added[1].recipient)]);

    expect(listed(await recipients())).toEqual([added[0].recipient.did, added[2].recipient.did]);
  });

  it("lists nothing of another account", async () => {
    const other = await peer4Agent(null);
    await register((await enrollment(other)).grant, firstContact(other));

    expect(listed(await recipients(known(other)))).toEqual([]);
  });

  it("refuses a body that is not exactly a page to ask for", async () => {
    for (const body of [
      {},
      { paginate: null },
      { paginate: { limit: 2 } },
      { paginate: { limit: 2, offset: 0, cursor: null } },
      { paginate: { limit: 0, offset: 0 } },
      { paginate: { limit: TEST_CONFIG.maxMembershipPage + 1, offset: 0 } },
      { paginate: { limit: 1.5, offset: 0 } },
      { paginate: { limit: 2, offset: -1 } },
      { paginate: { limit: 2, offset: "0" } },
      { paginate: { limit: 2, offset: 0 }, recipient_did: added[0].recipient.did },
    ]) {
      await expectProblem(await send(known(account), RECIPIENT_QUERY, body), "invalid-message");
    }
  });

  it("needs an account, and discloses nothing of one to its replica", async () => {
    const stranger = await peer4Agent(null);
    const member = await enrollment();
    await register(member.grant);

    await expectProblem(await recipients(firstContact(stranger)), "unknown-account");
    await expectProblem(await recipients(known(member.replica)), "unknown-account");
  });
});

describe("a long form", () => {
  let decode: MockInstance<typeof bs58.decode>;

  beforeEach(async () => {
    await register((await enrollment()).grant);
    decode = vi.spyOn(bs58, "decode");
  });

  afterEach(() => {
    decode.mockRestore();
  });

  /** A sound long form that nothing has decoded yet, the test included. */
  function unread(padding: number): string {
    return encodeLongForm({ nonce: randomUUID(), padding: "x".repeat(padding) });
  }

  function decodings(longForm: string): number {
    const document = longForm.slice(longForm.lastIndexOf(":") + 2);
    return decode.mock.calls.filter(([encoded]) => encoded === document).length;
  }

  async function oversized(): Promise<string> {
    const longForm = unread(6200);
    expect(longForm.length).toBeGreaterThan(MAX_LONG_FORM_BYTES);
    return longForm;
  }

  it("within the limit is decoded to be checked", async () => {
    const longForm = unread(100);
    const { proof } = await addition();

    await update([
      {
        recipient_did: longToShort(longForm),
        action: "add",
        resolution_material: longForm,
        proof,
      },
    ]);

    expect(decodings(longForm)).toBeGreaterThan(0);
  });

  describe("over the limit is refused undecoded", () => {
    it("as the recipient or its resolution material", async () => {
      const [named, supplied] = [await oversized(), await oversized()];
      const { proof } = await addition();

      expectRefusedUpdate(
        await update([
          { recipient_did: named, action: "add", resolution_material: null, proof },
        ]),
        "invalid-recipient"
      );
      expectRefusedUpdate(
        await update([
          {
            recipient_did: longToShort(supplied),
            action: "add",
            resolution_material: supplied,
            proof,
          },
        ]),
        "invalid-recipient"
      );

      expect(decodings(named)).toBe(0);
      expect(decodings(supplied)).toBe(0);
    });

    it.each(["account", "aud", "recipient"])("as the %s a recipient proof names", async (field) => {
      const longForm = await oversized();
      const { recipient, payload } = await addition();

      expectRefusedUpdate(
        await add({ recipient, proof: await proofBy(recipient, { ...payload, [field]: longForm }) }),
        "invalid-recipient"
      );

      expect(decodings(longForm)).toBe(0);
    });

    it("as the DID in a recipient proof's key ID", async () => {
      const longForm = await oversized();
      const { recipient, payload } = await addition();

      expectRefusedUpdate(
        await add({
          recipient,
          proof: await proofBy(recipient, payload, { kid: `${longForm}#key-1` }),
        }),
        "invalid-recipient"
      );

      expect(decodings(longForm)).toBe(0);
    });

    it("as the replica or the mediator a grant names", async () => {
      const [replica, named] = [await oversized(), await oversized()];
      const { payload } = await enrollment();

      await expectProblem(
        await register(
          await signedBy(account, {
            ...payload,
            replica_did: longToShort(replica),
            replica_long_form: replica,
          }),
          known(account)
        ),
        "invalid-grant"
      );
      await expectProblem(
        await register(await signedBy(account, { ...payload, mediator: named }), known(account)),
        "invalid-grant"
      );

      expect(decodings(replica)).toBe(0);
      expect(decodings(named)).toBe(0);
    });

    it("as the DID in a grant's key ID", async () => {
      const longForm = await oversized();
      const { payload } = await enrollment();

      await expectProblem(
        await register(
          await signedBy(account, payload, { kid: `${longForm}#key-1` }),
          known(account)
        ),
        "invalid-grant"
      );

      expect(decodings(longForm)).toBe(0);
    });
  });
});

/** An envelope sealed to `to`, which nobody here can open. */
async function envelope(to: Peer4Agent, content = "hello"): Promise<Record<string, unknown>> {
  return JSON.parse(
    await packAnonymous(plaintext("https://example.test/note", { content }), to.longForm)
  );
}

async function post(forward: IMessage, to: Hono = app): Promise<Response> {
  return to.request("/", {
    method: "POST",
    headers: { "content-type": ENCRYPTED },
    body: await packAnonymous(forward, mediator.did),
  });
}

describe("a forward", () => {
  let first: Enrollment;
  let second: Enrollment;
  let shared: Peer4Agent;

  beforeEach(async () => {
    first = await enrollment();
    second = await enrollment();
    await register(first.grant);
    await register(second.grant);
    const added = await addition();
    await add(added);
    shared = added.recipient;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const waiting = (replica: Enrollment) => store.deliveriesFor(replica.replica.did, 100);

  it("to a shared recipient waits once for each replica, under a delivery ID of its own", async () => {
    const inner = await envelope(shared);

    expect((await post(forwardOf(shared.did, inner))).status).toBe(202);

    const [forFirst] = await waiting(first);
    const [forSecond] = await waiting(second);
    expect(forFirst.packed).toBe(canonicalize(inner));
    expect(forSecond.packed).toBe(forFirst.packed);
    expect(forFirst.id).toMatch(/^[0-9a-f]{32}$/);
    expect(forSecond.id).toMatch(/^[0-9a-f]{32}$/);
    expect(forSecond.id).not.toBe(forFirst.id);
  });

  it("reaches no replica enrolled after it, however often it is repeated", async () => {
    const forward = forwardOf(shared.did, await envelope(shared));
    await post(forward);
    const before = await waiting(first);
    const late = await enrollment();
    await register(late.grant);

    expect((await post(forward)).status).toBe(202);

    expect(await waiting(late)).toEqual([]);
    expect(await waiting(first)).toEqual(before);
    expect(await waiting(second)).toHaveLength(1);

    await post(forwardOf(shared.did, await envelope(shared, "later")));
    expect(await waiting(late)).toHaveLength(1);
  });

  it("keeps the first bytes its recipient and ID were given", async () => {
    const forward = forwardOf(shared.did, await envelope(shared));
    await post(forward);

    const other = forwardOf(shared.did, await envelope(shared, "something else"), {
      id: forward.id,
    });

    expect((await post(other)).status).toBe(422);
    expect(await waiting(first)).toHaveLength(1);
  });

  it("names its recipient in either spelling", async () => {
    const forward = forwardOf(shared.longForm, await envelope(shared));

    expect((await post(forward)).status).toBe(202);
    expect((await post({ ...forward, body: { next: shared.did } })).status).toBe(202);

    expect(await waiting(first)).toHaveLength(1);
  });

  it("to a replica waits for that replica alone", async () => {
    const inner = await envelope(second.replica);

    expect((await post(forwardOf(second.replica.did, inner))).status).toBe(202);
    const late = await enrollment();
    await register(late.grant);

    expect((await waiting(second)).map((delivery) => delivery.packed)).toEqual([
      canonicalize(inner),
    ]);
    expect(await waiting(first)).toEqual([]);
    expect(await waiting(late)).toEqual([]);
  });

  it("with one ID is separate mail for each recipient it names", async () => {
    const forward = forwardOf(shared.did, await envelope(shared));
    await post(forward);

    const toReplica = forwardOf(second.replica.did, await envelope(second.replica), {
      id: forward.id,
    });

    expect((await post(toReplica)).status).toBe(202);
    expect(await waiting(second)).toHaveLength(2);
    expect(await waiting(first)).toHaveLength(1);
  });

  it("is refused with one answer for an account, a stranger and a full account", async () => {
    const stranger = await peer4Agent(mediator.did);
    const unknown = await post(forwardOf(stranger.did, await envelope(stranger)));
    const toAccount = await post(forwardOf(account.did, await envelope(account)));
    for (let i = 0; i < TEST_CONFIG.maxMessagesPerAccount; i++) {
      await post(forwardOf(shared.did, await envelope(shared)));
    }
    const full = await post(forwardOf(shared.did, await envelope(shared)));

    for (const refused of [unknown, toAccount, full]) {
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: "The forward was not queued" });
    }
  });

  it("is refused whole, and can be sent again, when a delivery of it cannot be written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-fanout-"));
    const file = join(dir, "mediator.db");
    store = new SqliteStore(file);
    app = serve();
    await register(first.grant);
    await register(second.grant);
    const added = await addition();
    await add(added);
    const raw = new Database(file);
    raw.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON replica_deliveries " +
        `WHEN NEW.replica_did = '${second.replica.did}' ` +
        "BEGIN SELECT RAISE(ABORT, 'delivery blocked'); END"
    );
    const forward = forwardOf(added.recipient.did, await envelope(added.recipient));

    const refused = await post(forward);

    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "The forward was not queued" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM replica_packages").get()).toEqual({ n: 0 });
    expect(await waiting(first)).toEqual([]);

    raw.exec("DROP TRIGGER fail_delivery");
    expect((await post(forward)).status).toBe(202);
    expect(await waiting(first)).toHaveLength(1);
    expect(await waiting(second)).toHaveLength(1);

    raw.close();
    store.close();
    rmSync(dir, { recursive: true });
  });

  it("counts once against its account, shared or not, whatever waits for each replica", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post(forwardOf(shared.did, await envelope(shared)))).status).toBe(202);
    }
    for (let i = 0; i < 2; i++) {
      const toReplica = forwardOf(second.replica.did, await envelope(second.replica));
      expect((await post(toReplica)).status).toBe(202);
    }

    expect((await post(forwardOf(shared.did, await envelope(shared)))).status).toBe(422);
    expect(
      (await post(forwardOf(first.replica.did, await envelope(first.replica)))).status
    ).toBe(422);
    expect(await waiting(first)).toHaveLength(3);
    expect(await waiting(second)).toHaveLength(5);
  });

  it("is refused whole once its account holds the bytes it may", async () => {
    const inner = await envelope(shared);
    const bytes = Buffer.byteLength(canonicalize(inner)!);
    const tight = serve({ maxRetainedBytes: 2 * bytes });

    expect((await post(forwardOf(shared.did, inner), tight)).status).toBe(202);
    expect((await post(forwardOf(second.replica.did, inner), tight)).status).toBe(202);
    expect((await post(forwardOf(shared.did, inner), tight)).status).toBe(422);

    expect(await waiting(first)).toHaveLength(1);
    expect(await waiting(second)).toHaveLength(2);
  });

  it("leaves the accounts beside its own their full room", async () => {
    for (let i = 0; i < TEST_CONFIG.maxMessagesPerAccount; i++) {
      await post(forwardOf(shared.did, await envelope(shared)));
    }
    account = await peer4Agent(null);
    mediationId = uuidv7();
    const elsewhere = await enrollment();
    await register(elsewhere.grant);

    const forward = forwardOf(elsewhere.replica.did, await envelope(elsewhere.replica));

    expect((await post(forward)).status).toBe(202);
    expect(await waiting(elsewhere)).toHaveLength(1);
  });

  it("waits no longer than the mediator keeps mail, or than its sender allowed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Math.floor(Date.now() / 1000);
    const brief = forwardOf(shared.did, await envelope(shared), { expires_time: now + 60 });
    await post(brief);
    await post(forwardOf(shared.did, await envelope(shared)));

    vi.setSystemTime((now + 61) * 1000);
    expect(await waiting(first)).toHaveLength(1);

    vi.setSystemTime((now + TEST_CONFIG.messageTtlSeconds + 1) * 1000);
    expect(await waiting(first)).toEqual([]);
    expect(await waiting(second)).toEqual([]);
    expect(await store.purgeExpired()).toBe(2);
  });

  it("is refused when its sender's deadline has already passed", async () => {
    const late = forwardOf(shared.did, await envelope(shared), {
      expires_time: Math.floor(Date.now() / 1000) - 1,
    });

    expect((await post(late)).status).toBe(422);
    expect(await waiting(first)).toEqual([]);
  });

  it("frees its ID and its room once it has lapsed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Math.floor(Date.now() / 1000);
    const forward = forwardOf(shared.did, await envelope(shared), { expires_time: now + 60 });
    await post(forward);
    for (let i = 1; i < TEST_CONFIG.maxMessagesPerAccount; i++) {
      await post(forwardOf(shared.did, await envelope(shared), { expires_time: now + 60 }));
    }

    vi.setSystemTime((now + 61) * 1000);
    const again = forwardOf(shared.did, await envelope(shared, "anew"), { id: forward.id });

    expect((await post(again)).status).toBe(202);
    expect((await waiting(first)).map((delivery) => delivery.packed)).toEqual([
      canonicalize(again.attachments![0].data.json),
    ]);
  });

  it("finds nobody where replica mediation is off", async () => {
    const off = serve({ replicaMediation: false });

    expect((await post(forwardOf(shared.did, await envelope(shared)), off)).status).toBe(422);
    expect(await waiting(first)).toEqual([]);
  });
});

const PICKUP = "https://didcomm.org/messagepickup/3.0";
const STATUS = `${PICKUP}/status`;
const DELIVERY = `${PICKUP}/delivery`;

interface Attached {
  id: string;
  data: { base64: string };
}

const carried = (attached: Attached): unknown =>
  JSON.parse(Buffer.from(attached.data.base64, "base64url").toString());

describe("pickup by a replica", () => {
  let first: Enrollment;
  let second: Enrollment;
  let shared: Peer4Agent;

  beforeEach(async () => {
    first = await enrollment();
    second = await enrollment();
    await register(first.grant);
    await register(second.grant);
    const added = await addition();
    await add(added);
    shared = added.recipient;
  });

  const pickup = (
    replica: Enrollment,
    type: string,
    body: Record<string, unknown> = {},
    speaker: Speaker = known(replica.replica)
  ) => send(speaker, `${PICKUP}/${type}`, body);

  async function delivered(replica: Enrollment, body: Record<string, unknown> = {}) {
    const reply = await pickup(replica, "delivery-request", { limit: 10, ...body });
    return reply?.type === DELIVERY ? (reply.attachments as Attached[]) : [];
  }

  async function count(replica: Enrollment, body: Record<string, unknown> = {}) {
    return (await pickup(replica, "status-request", body))?.body.message_count;
  }

  it("hands over the shared mail and the replica's own, under either spelling of the replica", async () => {
    const toAll = await envelope(shared);
    const toFirst = await envelope(first.replica);
    await post(forwardOf(shared.did, toAll));
    await post(forwardOf(first.replica.did, toFirst));
    await post(forwardOf(second.replica.did, await envelope(second.replica)));

    for (const speaker of [known(first.replica), firstContact(first.replica)]) {
      const reply = await pickup(first, "delivery-request", { limit: 10 }, speaker);

      expect(reply?.type).toBe(DELIVERY);
      expect((reply?.attachments as Attached[]).map(carried)).toEqual([toAll, toFirst]);
    }
    expect(await count(first)).toBe(2);
  });

  it("gives each replica its own ID for the same shared envelope, the same on every request", async () => {
    await post(forwardOf(shared.did, await envelope(shared)));

    const [forFirst] = await delivered(first);
    const [forSecond] = await delivered(second);

    expect(forSecond.data).toEqual(forFirst.data);
    expect(forSecond.id).not.toBe(forFirst.id);
    expect((await delivered(first))[0].id).toBe(forFirst.id);
  });

  it("answers an empty queue with a status", async () => {
    const reply = await pickup(first, "delivery-request", { limit: 10 });

    expect(reply?.type).toBe(STATUS);
    expect(reply?.body).toEqual({ message_count: 0, live_delivery: false });
  });

  it("hands over no more than was asked for, and still counts what waits", async () => {
    for (let i = 0; i < 3; i++) {
      await post(forwardOf(shared.did, await envelope(shared)));
    }

    expect(await delivered(first, { limit: 2 })).toHaveLength(2);
    expect(await count(first)).toBe(3);
  });

  it("narrows to the recipient a request names, in either spelling, and echoes it", async () => {
    const toAll = await envelope(shared);
    await post(forwardOf(shared.did, toAll));
    await post(forwardOf(first.replica.did, await envelope(first.replica)));

    for (const recipient_did of [shared.did, shared.longForm]) {
      const reply = await pickup(first, "delivery-request", { recipient_did });

      expect(reply?.body).toEqual({ recipient_did });
      expect((reply?.attachments as Attached[]).map(carried)).toEqual([toAll]);
      expect((await pickup(first, "status-request", { recipient_did }))?.body).toEqual({
        message_count: 1,
        live_delivery: false,
        recipient_did,
      });
    }
  });

  it("reaches nothing of another replica by naming it as the recipient", async () => {
    await post(forwardOf(second.replica.did, await envelope(second.replica)));

    const reply = await pickup(first, "delivery-request", { recipient_did: second.replica.did });

    expect(reply?.type).toBe(STATUS);
    expect(reply?.body.message_count).toBe(0);
    expect(await count(first)).toBe(0);
  });

  it("ends only the acknowledging replica's delivery, whatever IDs it names", async () => {
    await post(forwardOf(shared.did, await envelope(shared)));
    const [forFirst] = await delivered(first);
    const [forSecond] = await delivered(second);

    const reply = await pickup(first, "messages-received", {
      message_id_list: [forFirst.id, forSecond.id, "no-such-delivery", 7],
    });

    expect(reply?.type).toBe(STATUS);
    expect(reply?.body.message_count).toBe(0);
    expect((await delivered(second)).map((attached) => attached.id)).toEqual([forSecond.id]);

    await pickup(first, "messages-received", { message_id_list: [forFirst.id] });
    expect(await count(second)).toBe(1);
  });

  it("still knows an acknowledged shared envelope as a repeat, and queues it for no one again", async () => {
    const forward = forwardOf(shared.did, await envelope(shared));
    await post(forward);
    for (const replica of [first, second]) {
      const ids = (await delivered(replica)).map((attached) => attached.id);
      await pickup(replica, "messages-received", { message_id_list: ids });
    }
    const late = await enrollment();
    await register(late.grant);

    expect((await post(forward)).status).toBe(202);
    const changed = forwardOf(shared.did, await envelope(shared, "other"), { id: forward.id });
    expect((await post(changed)).status).toBe(422);

    for (const replica of [first, second, late]) {
      expect(await count(replica)).toBe(0);
    }
  });

  it("frees the room of mail forwarded to the replica once it is acknowledged", async () => {
    for (let i = 0; i < TEST_CONFIG.maxMessagesPerAccount; i++) {
      await post(forwardOf(first.replica.did, await envelope(first.replica)));
    }
    const refused = forwardOf(first.replica.did, await envelope(first.replica));
    expect((await post(refused)).status).toBe(422);

    const ids = (await delivered(first)).map((attached) => attached.id);
    await pickup(first, "messages-received", { message_id_list: ids });

    expect((await post(refused)).status).toBe(202);
    expect(await count(first)).toBe(1);
  });

  it("shares nothing with an ordinary account's queue, in either direction", async () => {
    const holder = await agent("holder");
    await send(holder, MEDIATE_REQUEST, {});
    await post(forwardOf(holder.did, JSON.parse(await packAnonymous(plaintext("note", {}), holder.did))));
    await post(forwardOf(first.replica.did, await envelope(first.replica)));
    const [held] = (await send(holder, `${PICKUP}/delivery-request`, { limit: 10 }))
      ?.attachments as Attached[];
    const [forFirst] = await delivered(first);

    await pickup(first, "messages-received", { message_id_list: [held.id] });
    const reply = await send(holder, `${PICKUP}/messages-received`, {
      message_id_list: [forFirst.id],
    });

    expect(reply?.body.message_count).toBe(1);
    expect(await count(first)).toBe(1);
  });

  it("is not answered for a request the replica signed without sealing it, and keeps the mail", async () => {
    await post(forwardOf(first.replica.did, await envelope(first.replica)));
    const [waiting] = await delivered(first);
    const acknowledgement = plaintext(
      `${PICKUP}/messages-received`,
      { message_id_list: [waiting.id] },
      { from: first.replica.did, to: [mediator.did], return_route: "all" }
    );

    for (const [packed, contentType] of [
      [await packSigned(first.replica, acknowledgement), SIGNED],
      [await packSigned(first.replica, acknowledgement, mediator.did), ENCRYPTED],
    ]) {
      const res = await app.request("/", {
        method: "POST",
        headers: { "content-type": contentType },
        body: packed,
      });

      expect(await res.text()).toBe("");
      expect(await count(first)).toBe(1);
    }
  });

  it("is not answered for a DID that is nobody's replica", async () => {
    const stranger = await peer4Agent(mediator.did);

    expect(await send(firstContact(stranger), `${PICKUP}/status-request`, {})).toBeNull();
  });

  it("has no live mode outside a connection that stays open", async () => {
    const reply = await pickup(first, "live-delivery-change", { live_delivery: true });

    expect(reply?.type).toBe(PROBLEM);
    expect(reply?.body.code).toBe("e.m.live-mode-not-supported");
  });
});

describe("live delivery to a replica", () => {
  let server: MediatorServer;
  let origin: string;
  let first: Enrollment;
  let second: Enrollment;
  let shared: Peer4Agent;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    server = buildServer({ identity: mediator, store, config: TEST_CONFIG });
    app = server.app;
    origin = `127.0.0.1:${await server.listen()}`;
    first = await enrollment();
    second = await enrollment();
    await register(first.grant);
    await register(second.grant);
    const added = await addition();
    await add(added);
    shared = added.recipient;
  });

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.close());
    await server.close();
  });

  function frame(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      socket.once("message", (data) => resolve(data.toString()));
      setTimeout(() => reject(new Error("timed out waiting for a frame")), 5000);
    });
  }

  async function ask(socket: WebSocket, speaker: Speaker, type: string, body = {}) {
    const answer = frame(socket);
    socket.send(
      await speaker.ctx.packEncrypted(
        plaintext(`${PICKUP}/${type}`, body, {
          from: speaker.did,
          to: [mediator.did],
          return_route: "all",
        }),
        mediator.did
      )
    );
    return (await speaker.ctx.unpack(await answer)).message;
  }

  async function connected(): Promise<WebSocket> {
    const socket = new WebSocket(`ws://${origin}/`);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return socket;
  }

  /** A socket the replica has turned live mode on for. */
  async function listening(speaker: Speaker): Promise<WebSocket> {
    const socket = await connected();
    const status = await ask(socket, speaker, "live-delivery-change", { live_delivery: true });
    expect(status.body.live_delivery).toBe(true);
    return socket;
  }

  async function forwarded(forward: IMessage): Promise<void> {
    const res = await fetch(`http://${origin}/`, {
      method: "POST",
      headers: { "content-type": ENCRYPTED },
      body: await packAnonymous(forward, mediator.did),
    });
    expect(res.status).toBe(202);
  }

  async function pushedTo(replica: Enrollment, pushed: string): Promise<Attached[]> {
    const { message } = await replica.replica.shortCtx.unpack(pushed);
    expect(message.type).toBe(DELIVERY);
    return message.attachments as Attached[];
  }

  it("pushes a shared envelope to every listening replica under the ID pickup gives it", async () => {
    const toFirst = await listening(firstContact(first.replica));
    const toSecond = await listening(known(second.replica));
    const inner = await envelope(shared);
    const pushes = [frame(toFirst), frame(toSecond)];

    await forwarded(forwardOf(shared.did, inner));

    const [forFirst] = await pushedTo(first, await pushes[0]);
    const [forSecond] = await pushedTo(second, await pushes[1]);
    expect(carried(forFirst)).toEqual(inner);
    expect(carried(forSecond)).toEqual(inner);
    expect(forSecond.id).not.toBe(forFirst.id);

    const waiting = await ask(toFirst, firstContact(first.replica), "delivery-request", { limit: 10 });
    expect((waiting.attachments as Attached[]).map((attached) => attached.id)).toEqual([forFirst.id]);
  });

  it("pushes mail forwarded to one replica to that replica's connections alone", async () => {
    const toFirst = await listening(known(first.replica));
    const alsoToFirst = await listening(known(first.replica));
    const toSecond = await listening(known(second.replica));
    const pushes = [frame(toFirst), frame(alsoToFirst)];

    await forwarded(forwardOf(first.replica.did, await envelope(first.replica)));

    const [[one], [other]] = await Promise.all(
      pushes.map(async (pushed) => pushedTo(first, await pushed))
    );
    expect(other.id).toBe(one.id);
    const next = await ask(toSecond, known(second.replica), "status-request");
    expect(next.type).toBe(STATUS);
    expect(next.body.message_count).toBe(0);
  });

  it("keeps the mail a push offered until it is acknowledged, and through a lost connection", async () => {
    const toFirst = await listening(known(first.replica));
    const push = frame(toFirst);
    await forwarded(forwardOf(shared.did, await envelope(shared)));
    const [offered] = await pushedTo(first, await push);
    toFirst.close();

    const again = await listening(known(first.replica));
    const waiting = await ask(again, known(first.replica), "delivery-request", { limit: 10 });
    expect((waiting.attachments as Attached[]).map((attached) => attached.id)).toEqual([offered.id]);

    const status = await ask(again, known(first.replica), "messages-received", {
      message_id_list: [offered.id],
    });
    expect(status.body.message_count).toBe(0);
  });

  it("answers the replica a connection belongs to in either spelling", async () => {
    const socket = await listening(firstContact(first.replica));

    const status = await ask(socket, known(first.replica), "status-request");

    expect(status.type).toBe(STATUS);
    expect(status.body.live_delivery).toBe(true);
  });

  it("refuses another replica on a connection, and leaves its live mode as it was", async () => {
    const socket = await listening(known(first.replica));

    for (const [type, body] of [
      ["status-request", {}],
      ["delivery-request", { limit: 1 }],
      ["messages-received", { message_id_list: [] }],
      ["live-delivery-change", { live_delivery: false }],
    ] as const) {
      const refusal = await ask(socket, known(second.replica), type, body);
      expect(refusal.type).toBe(PROBLEM);
      expect(refusal.body.code).toBe("e.p.msg.connection-bound");
    }

    const push = frame(socket);
    await forwarded(forwardOf(shared.did, await envelope(shared)));
    expect(await pushedTo(first, await push)).toHaveLength(1);
  });

  it("turns on no live mode for a replica on a connection another one opened", async () => {
    const socket = await connected();
    await ask(socket, known(first.replica), "status-request");

    const refusal = await ask(socket, known(second.replica), "live-delivery-change", {
      live_delivery: true,
    });

    expect(refusal.body.code).toBe("e.p.msg.connection-bound");
    const status = await ask(socket, known(first.replica), "status-request");
    expect(status.body.live_delivery).toBe(false);
  });

  it("refuses a replica on a connection its account opened", async () => {
    const socket = await connected();
    const told = await ask(socket, known(account), "status-request");
    expect(told.body.code).toBe(problem("replica-required"));

    const refusal = await ask(socket, known(first.replica), "live-delivery-change", {
      live_delivery: true,
    });

    expect(refusal.type).toBe(PROBLEM);
    expect(refusal.body.code).toBe("e.p.msg.connection-bound");
  });
});

describe("remove", () => {
  let first: Enrollment;
  let second: Enrollment;
  let shared: Peer4Agent;

  beforeEach(async () => {
    first = await enrollment();
    second = await enrollment();
    await register(first.grant);
    await register(second.grant);
    const added = await addition();
    await add(added);
    shared = added.recipient;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const remove = (replica: Enrollment, speaker: Speaker = known(account)) =>
    send(speaker, REMOVE, { replica_id: replica.replicaId });

  const waiting = (replica: Enrollment) => store.deliveriesFor(replica.replica.did, 100);

  const states = async () =>
    ((await roster(known(account), 2))?.body.entries as { state: string }[]).map(
      (entry) => entry.state
    );

  it("ends a replica's enrollment, and answers a repeat with the time of the first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Math.floor(Date.now() / 1000);

    const reply = await remove(first);
    vi.setSystemTime((now + 60) * 1000);
    const again = await remove(first);

    expect(reply?.type).toBe(REMOVED);
    expect(reply?.body).toEqual({
      replica_id: first.replicaId,
      state: "removed",
      removed_time: now,
    });
    expect(again?.body).toEqual(reply?.body);
  });

  it("keeps the replica in the roster, in its place and as removed", async () => {
    const removed = await remove(first);

    const listed = await roster(known(account), 2);

    expect(listed?.body.entries).toEqual([
      {
        grant: first.grant,
        state: "removed",
        registered_time: expect.any(Number),
        removed_time: removed?.body.removed_time,
      },
      {
        grant: second.grant,
        state: "active",
        registered_time: expect.any(Number),
        removed_time: null,
      },
    ]);
  });

  it("never enrolls the replica's ID or its DID again", async () => {
    await remove(first);
    const sameDid = await enrollment(account, {
      replica_did: first.replica.did,
      replica_long_form: first.replica.longForm,
    });
    const sameId = await enrollment(account, { replica_id: first.replicaId });
    const other = await peer4Agent(null);
    const elsewhere = await enrollment(other, {
      replica_did: first.replica.did,
      replica_long_form: first.replica.longForm,
    });

    await expectProblem(await register(first.grant), "identity-conflict");
    await expectProblem(await register(sameDid.grant), "identity-conflict");
    await expectProblem(await register(sameId.grant), "identity-conflict");
    await expectProblem(await register(elsewhere.grant, firstContact(other)), "identity-conflict");
    expect(await states()).toEqual(["removed", "active"]);
  });

  it("makes room under the replica limit", async () => {
    await register((await enrollment()).grant);
    const over = await enrollment();
    await expectProblem(await register(over.grant), "quota");

    await remove(first);

    expect((await register(over.grant))?.type).toBe(REGISTERED);
  });

  it("drops what waited for the replica, its own mail with the room it took, and leaves the others theirs", async () => {
    await post(forwardOf(shared.did, await envelope(shared)));
    for (let i = 1; i < TEST_CONFIG.maxMessagesPerAccount; i++) {
      await post(forwardOf(first.replica.did, await envelope(first.replica)));
    }
    const refused = forwardOf(shared.did, await envelope(shared));
    expect((await post(refused)).status).toBe(422);

    await remove(first);

    expect(await waiting(first)).toEqual([]);
    expect(await waiting(second)).toHaveLength(1);
    expect((await post(refused)).status).toBe(202);
    expect(await waiting(second)).toHaveLength(2);
  });

  it("queues nothing more for the replica, shared or its own", async () => {
    await remove(first);

    expect((await post(forwardOf(shared.did, await envelope(shared)))).status).toBe(202);
    expect((await post(forwardOf(first.replica.did, await envelope(first.replica)))).status).toBe(
      422
    );

    expect(await waiting(first)).toEqual([]);
    expect(await waiting(second)).toHaveLength(1);
  });

  it("tells the removed replica so when it asks for pickup, in either spelling", async () => {
    await remove(first);

    for (const speaker of [known(first.replica), firstContact(first.replica)]) {
      for (const [type, body] of [
        ["status-request", {}],
        ["delivery-request", { limit: 10 }],
        ["messages-received", { message_id_list: [] }],
      ] as const) {
        await expectProblem(await send(speaker, `${PICKUP}/${type}`, body), "replica-removed");
      }
    }
  });

  it("says nothing to a removed replica that only signed its request", async () => {
    await remove(first);
    const request = plaintext(
      `${PICKUP}/status-request`,
      {},
      { from: first.replica.did, to: [mediator.did], return_route: "all" }
    );

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": SIGNED },
      body: await packSigned(first.replica, request),
    });

    expect(await res.text()).toBe("");
  });

  it("keeps the account when its last replica goes, with mail still taken and none delivered", async () => {
    await remove(first);
    await remove(second);
    const late = await enrollment();

    expect(await states()).toEqual(["removed", "removed"]);
    expect((await post(forwardOf(shared.did, await envelope(shared)))).status).toBe(202);
    expect((await register(late.grant, known(account)))?.type).toBe(REGISTERED);
    expect(await waiting(late)).toEqual([]);
  });

  it("refuses an ID the account never enrolled, another account's included", async () => {
    const other = await peer4Agent(null);
    const theirs = await enrollment(other);
    await register(theirs.grant, firstContact(other));

    await expectProblem(await remove(theirs), "unknown-replica");
    await expectProblem(
      await send(known(account), REMOVE, { replica_id: uuidv7() }),
      "unknown-replica"
    );
    expect(await store.replicaState(theirs.replica.did)).toBe("active");
  });

  it("refuses a body that is not exactly a replica ID", async () => {
    for (const body of [
      {},
      { replica_id: 1 },
      { replica_id: first.replicaId, replica_did: first.replica.did },
      { replica_did: first.replica.did },
    ]) {
      await expectProblem(await send(known(account), REMOVE, body), "invalid-message");
    }
    expect(await states()).toEqual(["active", "active"]);
  });

  it("is the account's alone to ask for", async () => {
    const stranger = await peer4Agent(null);

    await expectProblem(await remove(first, firstContact(stranger)), "unknown-account");
    await expectProblem(await remove(first, known(first.replica)), "unknown-account");
    await expectProblem(await remove(second, known(first.replica)), "unknown-account");
    expect(await states()).toEqual(["active", "active"]);
  });
});

describe("a replica-mediation account beside ordinary mediation", () => {
  it("is never granted ordinary mediation, under either spelling", async () => {
    const first = await enrollment();
    await register(first.grant);

    for (const speaker of [firstContact(account), known(account), known(first.replica)]) {
      expect((await send(speaker, MEDIATE_REQUEST, {}))?.type).toBe(MEDIATE_DENY);
    }
    expect((await roster())?.body.entries).toHaveLength(1);
  });

  it("cannot be bound as an ordinary account's recipient", async () => {
    const first = await enrollment();
    await register(first.grant);
    const holder = await agent("holder");
    await send(holder, MEDIATE_REQUEST, {});

    const reply = await send(holder, KEYLIST_UPDATE, {
      updates: [account.did, account.longForm, first.replica.did, first.replica.longForm].map(
        (recipient_did) => ({ recipient_did, action: "add" })
      ),
    });

    expect((reply?.body.updated as { result: string }[]).map((update) => update.result)).toEqual([
      "client_error",
      "client_error",
      "client_error",
      "client_error",
    ]);
  });

  it("is told that pickup is a replica's to ask for", async () => {
    await register((await enrollment()).grant);

    for (const [type, body] of [
      ["status-request", {}],
      ["delivery-request", { limit: 1 }],
      ["messages-received", { message_id_list: [] }],
      ["live-delivery-change", { live_delivery: true }],
    ] as const) {
      await expectProblem(
        await send(known(account), `https://didcomm.org/messagepickup/3.0/${type}`, body),
        "replica-required"
      );
    }
  });
});
