# @estoc/did-peer

did:peer:2 and did:peer:4 — encoding, resolution, what a DID document's
verification relationships authorize, and conversion to the flat `DIDDoc`
shape [didcomm-rust](https://github.com/sicpa-dlab/didcomm-rust) expects.

Everything here is pure: encoding and decoding of the [Peer DID method](https://identity.foundation/peer-did-method-spec/),
and reading a DID document already in hand. For both peer methods the document *is* the identifier, so resolution never
touches the network and no store can be out of date: what a long form decodes
to is worked out from its text, and once worked out is kept in memory (see
below). One source runs unchanged in Node (≥22), Cloudflare workerd, and a
browser with `String.prototype.isWellFormed`: sha256 comes from
`@noble/hashes`, base64 from `atob`/`btoa`, and RFC 8785 from `canonicalize`,
which needs that method.

```sh
npm install @estoc/did-peer
```

## Usage

```ts
import {
  encodeLongForm,
  resolveDIDCommDoc,
  resolvePeer2,
  toDIDCommDIDDoc,
} from "@estoc/did-peer";

// Mint a did:peer:4 long form from an input document
const did = encodeLongForm({
  verificationMethod: [
    /* ... */
  ],
  service: [
    /* ... */
  ],
});

// Resolve either peer method straight to a didcomm-rust DIDDoc
const didDoc = await resolveDIDCommDoc(did);

// Or work with the raw W3C-shaped document
const raw = resolvePeer2("did:peer:2.Ez6LS...");
const converted = toDIDCommDIDDoc(raw);
```

## What's in

- **did:peer:2** — `isPeerDID2`, `resolvePeer2`
- **did:peer:4** — `isPeerDID4`, `isLongForm`, `isShortForm`, `encodeLongForm`,
  `encodeShortForm`, `longToShort`, `resolveLongForm`, `resolveShortForm`,
  `validateInputDocument`
- **Reading a DID document** — `authorizedMethodIds`, `definedMethod`,
  `serviceIds`, with `splitDidUrl`, `isDid` and `isDidUrl`: what the
  verification relationships of any DID document authorize, and the entry
  that defines each method, its ID resolved. A fragment or query reference
  resolves against the document's `id`, a reference into the document names
  a method it defines, and one ID defines one method or one service; anything
  else is a `DIDDocumentError`. Two definitions of one method are the same
  RFC 8785 text once their IDs are resolved, so a method defined twice with
  a value that has none, a lone surrogate or a number beyond a double, is
  refused. A service ID is an absolute URI as it stands, or a fragment or
  query reference resolved the same way. The code that signs and the code
  that verifies read a document through these and name the same method for
  a key. Whether to keep a document at all, with every member in the shape
  DID Core gives it and every service ID a well-formed URI, stays the
  application's policy.
- **DIDDoc conversion** — `toDIDCommDIDDoc` flattens a W3C DID document into
  didcomm-rust's `DIDDoc`: the relationships and methods as the reader above
  reads them, every method the document defines hoisted into
  `verificationMethod` wherever it is embedded, absolute DID URLs, only
  DIDCommMessaging services retained. A document the reader refuses is a
  `DIDDocConversionError`
- **`resolveDIDCommDoc`** — both peer methods straight to a `DIDDoc`, the
  signature a didcomm resolver wants
- **base64url helpers** — `Buffer`-free, work everywhere
- **`@estoc/did-peer/remembered`** — `remembered` keeps what a pure function of
  a string made of the inputs it saw last; `frozen` makes a result one that
  every caller can be handed

A did:peer:4 long form decodes to the same document every time, so
`decodeLongForm` works each spelling out once and hands every caller the same
frozen document. Copy it to change it.

## What's out, by design

Resolver composition (did:web, caching, pinning), WASM loading, and secrets
handling are application policy and stay in the applications. This package is
the shared lineage of [didcomm-mediator](https://github.com/estoc-dev/didcomm-mediator)
and [didcomm-demo](https://github.com/estoc-dev/didcomm-demo), extracted once
three copies agreed byte-for-byte.

## Status

Experimental, pre-1.0: the API may still move. This package has not received
an independent security audit — review it yourself before trusting it with
anything valuable.

## License

Apache-2.0
