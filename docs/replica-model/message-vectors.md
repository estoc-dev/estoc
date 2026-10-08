# Message layer vectors

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1
<!-- suite-navigation:end -->

Status: **vectors**. Fixed inputs with the canonical bytes and CIDs the
message layers of
[distributed-delivery.md section 5](distributed-delivery.md#canonical-projections-and-hashes)
give over them. The rules live there and in
[vault-events.md](vault-events.md); this appendix is what the tests
reproduce. Every CID is the raw DASL CID of
[dasl-objects.md](dasl-objects.md#accepted-dasl-cids) over the UTF-8 of the
RFC 8785 text shown, and every UUIDv5 follows
[vault-events.md section 3.4](vault-events.md#entity-ids-and-reproducible-uuidv5-namespaces).

## Fixture

```text
ours  = did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd
peer  = did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP
id    = 019b2a70-e2c8-7fb4-b63f-1aca32152062
other = 019b2a70-f225-721c-835f-67175be0667e
type  = https://didcomm.org/basicmessage/2.0/message
body  = {"content":"hello"}
created_time = 1788442800
```

## Stored message document

The document of `body` with no attachments:

```text
{"attachments":[],"body":{"content":"hello"}}
bodyCid = bafkreifjsojjektsxjm7ap5cq3oy4uf3vijc4l4yxikxrwclndlsany5me
```

With one inline JSON attachment `{"k":1}` under id `a1` and media type
`application/json`, the payload object and the document are:

```text
{"k":1}
root = bafkreifa3ip44v6q4t47blsojs7aidju3taemjk4nsgrr2l7kwvo2bsv6a

{"attachments":[{"byte_count":7,"data":{"hash":null,"jws":null,"kind":"json","root":"bafkreifa3ip44v6q4t47blsojs7aidju3taemjk4nsgrr2l7kwvo2bsv6a"},"description":null,"filename":null,"format":null,"id":"a1","lastmod_time":null,"media_type":"application/json"}],"body":{"content":"hello"}}
bodyCid = bafkreig7s23pgqrytmeiyzlqdwd2tr4ibtovvc4q6nq6yqccryr66imf3e
```

## Intent CID

The intent of the fixture message with its own thread, `please_ack: [""]`,
no expiry and no additional header. Its projection bytes and CID:

```text
["estoc.message.intent",1,{"ack":[],"created_time":1788442800,"document":"bafkreifjsojjektsxjm7ap5cq3oy4uf3vijc4l4yxikxrwclndlsany5me","expires_time":null,"headers":{},"please_ack":[""],"pthid":null,"thid":"","type":"https://didcomm.org/basicmessage/2.0/message"}]
intentCid = bafkreiem7tcs2b3noyacl5iegvaqpjgy77pptqpgpxhpdfzfvawhb6j7nu
```

The same intent CID results from each of these spellings of the same message:

| Input | Why |
| --- | --- |
| wire `thid` absent | self thread |
| wire `thid` equal to `id` | self thread |
| wire `please_ack: ["<id>"]` | self reference |
| own `id` replaced by `other` | the own ID is excluded |
| `from`, `to`, `from_prior`, `typ` changed or absent | addressing and proof are excluded |

Each of these is another intent:

| Change | `intentCid` |
| --- | --- |
| `created_time` 1788442801 | `bafkreidid3d4wna6upeqmyom5jirxner5yj4urkhzlqbahzonc53hokj5i` |
| `expires_time` 1788446400 | `bafkreie3fcb2zjzueqyfsfkfwpmw7fo7w3zz2pmxu5ytot5jvydpp2vbq4` |
| header `lang: "en"` | `bafkreibrmi25i7yxfkqzejz3riiws5domv2qesryz2txf4vwma2gtbsawe` |
| `please_ack` absent | `bafkreidg52mgoncqnli72hue5rkzcg52s3u43i527mws7yndk6nppwzzga` |
| `please_ack: []` | `bafkreidrzhnsotsbbvp2eo2uqgioai2s5u32x3eyy2qttpkcyyvurksjbi` |
| `thid` = `other` | `bafkreibvclxcgo52vduzlysrkm47u3ikdaa5xp46rsb7xyr27cwxr4dtd4` |
| `please_ack: ["<other>", ""]` | `bafkreibs4gq4ibpjhmkg2ckanhu6zls4uopksclycsrldomv75rnejk3ci` |
| the attachment `a1` added | `bafkreiawuwzqtp7wdihjclk2iv5hmuw7eivxh4yvewvqmygloa26cde6a4` |

The three `please_ack` rows show that absent, empty and present are three
intents, and that order and other references are kept. The attachment row is
the projection with `document` set to the attachment document's CID.

## Plaintext CID

The complete plaintext the fixture intent assembles to, sent from `ours` to
`peer` with no proof:

```text
{"body":{"content":"hello"},"created_time":1788442800,"from":"did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd","id":"019b2a70-e2c8-7fb4-b63f-1aca32152062","please_ack":[""],"to":["did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP"],"typ":"application/didcomm-plain+json","type":"https://didcomm.org/basicmessage/2.0/message"}
plaintextCid = bafkreihpzyq47ncv37altvbrhq2jb6m4dr2l2nqrsgxoqdne5va37rotlq
```

The same members in another order, or with other whitespace, give the same
CID. Each of these is another plaintext while its intent CID stays
`bafkreiem7tcs2b3noyacl5iegvaqpjgy77pptqpgpxhpdfzfvawhb6j7nu`:

| Change | `plaintextCid` |
| --- | --- |
| `"thid": null` added | `bafkreidqxt7irsq6dy7glysmvraujacrz3csavkdrkzwb2ib33zpywifoy` |
| `"thid": "<id>"` added | `bafkreifxwbzt7tydidretpqr4yr6vrsuopsnahu5zvjtiknlwlxmobpdbu` |
| `please_ack: ["<id>"]` | `bafkreieyvcxfsirniso2vth3o46o3unaemv6a2viehpgar5zg3nx7zpxi4` |
| `id` = `other` | `bafkreiavxf23wwuk46tyfzrhmapsltiejc6lyxaqkgmh4dkdn5ydblmfye` |

A preparer never emits the first three spellings; a receiver that is handed
them records their CIDs as they are.

## Forward ID

```text
estocNamespace("forward") = 065a85d2-b1e0-5b6f-9030-e2baafb0913d

preparationEventCid = bafkreia5n4chkt47rrkgjs65fwyplx7wbnpe6ke3fq6xbjsmgwrmwvhcs4
["v1","bafkreia5n4chkt47rrkgjs65fwyplx7wbnpe6ke3fq6xbjsmgwrmwvhcs4"]
forwardId = bc21dc07-fd00-54de-9ee6-eba82a332b94
```

The preparation event CID here is an arbitrary raw CID standing in for a
`message.prepared` event's; the rule is in
[vault-events.md](vault-events.md#forward-id-rule).

## Identities the layers do not decide

| Case | Intent CID | Message ID |
| --- | --- | --- |
| two user sends of the fixture content in one second | equal | different UUIDv7s |
| the fixture message sent again under its ID | equal | equal |
| one automatic output made by two replicas from two observations of one input | equal | equal, from the effect key |
| the fixture intent prepared twice | equal | equal; two envelope CIDs, two preparation event CIDs |
