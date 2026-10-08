/** What the test hands the Chromium Worker, and what comes back: a vault and a message crossing between Node and the browser. */

import type { JsonObject } from "@estoc/event-store";
import type { IMessage, Unpacked, secretsResolverFor, unpack } from "@estoc/agent-core";
import { envelopeOf, readPlaintext } from "@estoc/vault";

type Resolver = Parameters<typeof unpack>[2];
export type Document = NonNullable<Awaited<ReturnType<Resolver["resolve"]>>>;
export type Secrets = Parameters<typeof secretsResolverFor>[0];

/** The parties of the exchange, each a `did:web` DID whose document both runtimes resolve from here. */
export interface Parties {
  sender: string;
  recipient: string;
  documents: Record<string, Document>;
  secrets: { sender: Secrets; recipient: Secrets };
}

export interface CrossingInput {
  /** The kept vault's file, and the passphrase that opens it. */
  corpus: { bytes: number[]; passphrase: string };
  exchange: Parties & {
    /** The plaintext each runtime seals from the sender to the recipient. */
    plaintext: IMessage;
    /** What Node sealed of it. */
    sealed: string;
  };
}

/** What a runtime made of an envelope it opened: the plaintext, who sealed it, and the CID of each layer. */
export interface Opened {
  plaintext: IMessage;
  sealer: string | null;
  intentCid: string;
  plaintextCid: string;
  envelopeCid: string;
}

export interface CrossingOutput {
  corpus: {
    /** The read of the kept vault, as text. */
    fold: string;
    snapshot: string;
    /** The CID of each event and of each object, in the order the vault lists them, hashed here. */
    events: string[];
    objects: string[];
    /** The kept vault restored into a runtime here and exported again. */
    exported: number[];
  };
  exchange: {
    /** What the browser made of what Node sealed. */
    opened: Opened;
    /** What the browser sealed. */
    sealed: string;
  };
}

export type WorkerReply = { ok: true; output: CrossingOutput } | { ok: false; error: string };

export const resolverOf = (documents: Record<string, Document>): Resolver => ({ resolve: async (did) => documents[did] ?? null });

/** What a runtime makes of the envelope `packed`, once opened. */
export function openedOf({ plaintext, sender }: Unpacked, packed: string): Opened {
  const read = readPlaintext(plaintext as unknown as JsonObject);
  return { plaintext, sealer: sender?.kid ?? null, intentCid: read.intent.cid, plaintextCid: read.plaintextCid, envelopeCid: envelopeOf(packed).cid };
}
