import { mediatorHost, mediatorInputOf } from "@estoc/daemon-api/views";

/**
 * Known mediators. The default is Estoc's own mediator on Cloudflare
 * Workers under its did:web name — a mediator's DID is a function of its
 * keys and URL, and did:web is the name that stays put. The local entry is
 * `npm run dev` in the mediator repo: every checkout mints its own keys,
 * so there is no DID to hardcode — the entry is the URL, probed for its
 * DID at selection time.
 *
 * A fork points the demo at its own mediator without touching this file:
 * VITE_MEDIATOR_DID at build time (e.g. in .env.production) replaces the
 * Estoc entry as the default dropdown choice, labelled by the host its
 * DID names.
 */

export const ESTOC_MEDIATOR_WEB = "did:web:mediator.estoc.dev";
export const ESTOC_MEDIATOR_URL = "https://mediator.estoc.dev";

const CUSTOM_MEDIATOR = import.meta.env.VITE_MEDIATOR_DID?.trim();

export interface MediatorChoice {
  label: string;
  /** A DID, or a URL to probe for one when chosen. */
  value: string;
  /**
   * Take the probed mediator's DID with this prefix instead of its primary.
   * A mediator's peer DIDs are functions of its live keys, so they can only
   * be asked for, never hardcoded — the entry names the method, the probe
   * supplies the name.
   */
  prefer?: string;
}

const LOCAL_CHOICE: MediatorChoice = {
  label: "localhost:8080",
  value: "http://localhost:8080",
};

/**
 * The did:peer:2 alias of the same production mediator. Some correspondents
 * (demo.didcomm.org among them) mis-resolve a did:web routing DID whose
 * document carries JWK material; a profile minted on the peer:2 name routes
 * around that, since did:peer:2 inlines multibase keys and plain URLs.
 */
const ESTOC_PEER2_CHOICE: MediatorChoice = {
  label: "mediator.estoc.dev (did:peer:2)",
  value: ESTOC_MEDIATOR_URL,
  prefer: "did:peer:2",
};

export const MEDIATOR_CHOICES: MediatorChoice[] =
  CUSTOM_MEDIATOR !== undefined && CUSTOM_MEDIATOR !== ""
    ? [
        {
          label: mediatorHost(CUSTOM_MEDIATOR) ?? "custom mediator",
          value: CUSTOM_MEDIATOR,
        },
        LOCAL_CHOICE,
      ]
    : [
        { label: "mediator.estoc.dev", value: ESTOC_MEDIATOR_WEB },
        ESTOC_PEER2_CHOICE,
        LOCAL_CHOICE,
      ];

/**
 * A mediator can be handed over three ways, and they converge on its DID:
 * a DID pasted directly; an out-of-band invitation URL, whose `_oob`
 * parameter decodes to the invitation offline (the standard bootstrap, and
 * the DID inside is pinned by whoever handed over the URL); or a bare
 * mediator URL, probed with one GET for its JSON description — the only
 * form that has to trust what the server answers today.
 *
 * `prefer` picks one of the mediator's alias DIDs by prefix (say
 * `did:peer:2`) from the probe's `dids` list instead of its primary.
 */
export async function resolveMediatorInput(input: string, prefer?: string): Promise<string> {
  const read = mediatorInputOf(input);
  if (read.did !== null) return read.did;
  const url = new URL(read.url);
  let body: { did?: unknown; dids?: unknown } | null;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    body = (await res.json()) as { did?: unknown; dids?: unknown };
  } catch {
    throw new Error(`could not get a mediator description from ${url.host}`);
  }
  if (prefer !== undefined) {
    const dids = Array.isArray(body?.dids) ? body.dids : [];
    const match = dids.find((did): did is string => typeof did === "string" && did.startsWith(prefer));
    if (match === undefined) throw new Error(`${url.host} does not answer as a ${prefer} DID`);
    return match;
  }
  if (typeof body?.did !== "string" || !body.did.startsWith("did:")) throw new Error(`${url.host} did not answer with a mediator DID`);
  return body.did;
}

/**
 * A human name for a mediator DID: the known label, or its HTTP endpoint
 * host — with the method when it is a did:peer:2, since one host may be
 * reached under more than one name (and the picker offers both).
 */
export function mediatorLabel(did: string): string {
  const known = MEDIATOR_CHOICES.find((choice) => choice.value === did);
  if (known !== undefined) {
    return known.label;
  }
  const host = mediatorHost(did);
  if (host === null) {
    return "custom mediator";
  }
  return did.startsWith("did:peer:2") ? `${host} (did:peer:2)` : host;
}
