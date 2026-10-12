import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemoryVault, SqliteVault, VAULT_VERSION, exportVault, importVault, openPortable, restoreVault, type Event, type OpenDestination, type VaultRuntime } from "@estoc/event-store";
import { openNodeSqlite } from "@estoc/event-store/node";
import { createSeedKeystore } from "@estoc/keystore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ENROLLMENT_EVENT_TYPES,
  Keys,
  collectGarbage,
  mintMediationDid,
  rawCidOfBytes,
  requiredReceivingSet,
  scanVault,
  signReplicaGrant,
  vaultHeldRoots,
  vaultRetention,
  type Cid,
  type KeyName,
  type ReplicaId,
} from "../src/index.js";
import { MEDIATION, MEDIATION2, ROUTING_DID, ROUTING_DID2, SEED, vaultOf } from "./fold/helpers.js";
import { intent, preparationOf, resolved, vaults } from "./fold/scene.js";

const encoder = new TextEncoder();

const has = (vault: MemoryVault, cid: Cid) => vault.vault.objects.has(cid);

describe("the retention handed to the event store", () => {
  it("is the same for collection, export and validation", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0);
    const pkg = preparationOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root, envelope: "envelope" });
    scene.add("message.erased", { messageId: out.data.messageId, dropCids: [pkg.data.envelopeCid], because: "user" });
    const stray = rawCidOfBytes(encoder.encode("stray"));
    const vault = await vaultOf(scene, [`body ${out.data.messageId}`, "envelope", "stray"]);
    expect(new Set(await vaultHeldRoots(keys)(vault.vault))).toEqual(new Set([root.data.documentCid, out.data.bodyCid]));
    const collected = await collectGarbage(vault, keys);
    expect(collected.removed.sort()).toEqual([pkg.data.envelopeCid, stray].sort());
    expect(await has(vault, out.data.bodyCid)).toBe(true);
  });
});

describe("the events a new replica enrolls from", () => {
  const REPLICA = "019b2a43-4a56-7c0f-862f-194c0c4124a0" as ReplicaId;
  let dir: string;
  let n = 0;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "estoc-enrollment-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const at = (): OpenDestination => {
    const file = path.join(dir, `vault-${n++}.sqlite`);
    return (mode) => openNodeSqlite(file, { mode });
  };
  const exported = async (runtime: VaultRuntime, keys: Keys, types?: ReadonlySet<string>) => {
    const open = at();
    const validated = await exportVault(runtime, open, { heldRoots: vaultHeldRoots(keys), ...(types === undefined ? {} : { types }) });
    return { validated, snapshot: openPortable(await open("readonly")) };
  };

  it("carry no object; restored, they read as the vault's name, its arrangements and its replicas with no DID, and the whole history imported over them adds the rest, then nothing", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const me = (await mintMediationDid(keys, MEDIATION)).longFormDid;
    scene.add("identity.label", { name: "Home" });
    scene.add("mediation.created", { mediationId: MEDIATION2, mediatorDid: ROUTING_DID2, me: { keyName: `mediation/${MEDIATION2}/me` as KeyName, did: (await mintMediationDid(keys, MEDIATION2)).longFormDid } });
    scene.add("mediation.retired", { mediationId: MEDIATION2, because: "user" });
    scene.add("replica.created", { replicaId: REPLICA, mediationId: MEDIATION, grant: await signReplicaGrant(keys, { mediationId: MEDIATION, mediatorDid: ROUTING_DID, me: { did: me } }, REPLICA) });
    const out = intent(scene, a0, b0);
    const enrollment = scene.events.filter((event) => (ENROLLMENT_EVENT_TYPES as ReadonlySet<string>).has(event.type));
    expect(new Set(enrollment.map((event) => event.type))).toEqual(ENROLLMENT_EVENT_TYPES);
    expect(scene.events.length).toBeGreaterThan(enrollment.length);

    const { doc, seedKey } = await createSeedKeystore("passphrase", { seed: SEED });
    const anchor = await Keys.anchorOf(seedKey);
    const source = new MemoryVault({ metadata: { version: VAULT_VERSION, anchor }, wrapped: doc });
    const body = encoder.encode(`body ${out.data.messageId}`);
    await source.stores.objects.putObject(out.data.bodyCid, body);
    await source.ingest(scene.events);

    const entry = await exported(source, keys, ENROLLMENT_EVENT_TYPES);
    expect(entry.validated).toMatchObject({ events: enrollment.length, objects: 0 });
    const destination = at();
    const restored = await restoreVault(entry.snapshot, destination, { heldRoots: vaultHeldRoots(keys), anchor });
    entry.snapshot.close();
    const replica = new SqliteVault(restored.runtime);
    try {
      const fold = await scanVault(replica.vault, keys);
      expect(fold.label).toBe("Home");
      expect([fold.mediations.preferred, fold.mediations.mediations.get(MEDIATION)?.status, fold.mediations.mediations.get(MEDIATION2)?.status]).toEqual([MEDIATION, "usable", "retired"]);
      expect(fold.replicas.replicas.get(REPLICA)?.status).toBe("member");
      expect(fold.dids.entities.size).toBe(0);
      expect(requiredReceivingSet(fold.mediations, fold.dids)).toEqual(new Set([MEDIATION]));

      const whole = await exported(source, keys);
      expect(whole.validated).toMatchObject({ events: scene.events.length, objects: 1 });
      const imported = await importVault(replica, whole.snapshot, { retainedRoots: vaultRetention(keys) });
      expect(imported).toEqual({ added: scene.events.length - enrollment.length, duplicates: enrollment.length, objects: 1, repaired: 0 });
      const cids = async (runtime: VaultRuntime) => {
        const events: Event[] = [];
        for await (const event of runtime.vault.events.scan()) events.push(event);
        return events.map((event) => event.cid);
      };
      expect(await cids(replica)).toEqual(await cids(source));
      expect(await replica.vault.objects.read(out.data.bodyCid, body.length)).toEqual(body);
      expect(await importVault(replica, whole.snapshot, { retainedRoots: vaultRetention(keys) })).toEqual({ added: 0, duplicates: scene.events.length, objects: 0, repaired: 0 });
      whole.snapshot.close();
    } finally {
      await replica.close();
    }
  });
});
