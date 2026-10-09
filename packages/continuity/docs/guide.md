# Continuity illustrated: concepts and test boundaries

Starting from an oriented DID pair, this guide puts test inputs, derivation and
query results side by side. Read the [README](../README.md) and
[public types](../src/model.ts) for the API and integration contract. Test links
point to the fixed source revision used to check these examples.

Start with [both parties rotating and joining](#join), then explore
[contexts](#contexts), [links only the positive graph has](#diagnostic) and
[onward rotations](#onward). Proof input boundaries are collected under
[verification and binding](#proofs).

| Notation | Meaning |
| --- | --- |
| `C(A0,B0)` | From A's perspective: A0 is the local DID and B0 is the peer DID. Swapping them changes the question. |
| A0, A1, B0, B1 | DID abbreviations used in the tests. Numbers identify predecessors and successors in an example; they provide no timestamp or ordering authority. |
| `p1` | A `peer-transition`: the peer's verified and bound rotation or ending. |
| `d1` | A `local-decision`: a local rotation or ending decision the host has saved. |
| `o1` | An `address-observed` fact: an authenticated receipt from the peer to an **exact local DID**. |
| Dashed `join` edge | An edge derived from the two sides' rotations. It can be usable without another receipt. |
| Dashed `diagnostic` edge | An edge retained to explain history or ambiguity. It cannot serve as a usable path. |
| `support` | The facts supporting the asserted links or an individual confirmation, not every fact the answer depends on. |

A result names a fact by its key: its kind and its evidence, the receipt or
saved decision it rests on. The tables write the fact's label instead, as the
tests name it. Edges are labeled with their purpose. In dependency diagrams,
`source` and `carried` are fact references, not DID rotations.

## From evidence to queries

```mermaid
flowchart TB
    R["host: receipts, proofs,<br/>DID documents"] --> V["verify + bind"]
    V --> F["Three kinds of normalized fact"]
    D["host: saved local decisions"] --> F
    O["host: authenticated<br/>address observations"] --> F
    F --> M["deriveContinuity<br/>accept, then derive"]
    M --> Q["head / path / confirmation<br/>history / conflicts / status"]
    Q --> H["host: operation policy and commit"]
```

One receipt can supply both a transition and an observation. The transition
establishes how addresses continue; the observation establishes which address
the peer wrote to. A transition alone can establish topology. An observation
alone can confirm the exact address it records.

<a id="peer-rotation"></a>

## Receiving a peer rotation: continuation and confirmation have their own evidence

B1 writes to A0 carrying a B0-to-B1 proof. The host projects two facts: `p1`
declares the rotation at the old pair, and `o1` records the receipt at the new
pair. Both have that receipt as their evidence, so `o1` needs only `carried` to
say that the transition of its own receipt is `p1`.

```mermaid
flowchart LR
    C00["C(A0,B0)"] -->|"p1: peer B0 → B1"| C01["C(A0,B1)"]
    O1["o1: B1 wrote to A0<br/>carried: p1, same receipt"] --- C01
    CX["C(X0,B0)<br/>No connection to this history"]
```

| Query or variation | Result |
| --- | --- |
| `head(C(A0,B0))` | `head C(A0,B1)`, with support `[p1]`. |
| `head(C(A0,B1))` | The queried pair is already the head, with support `[]`. |
| `confirmation(A0,B0)` | `confirmed`, with witness `[o1,p1]` for `o1`. |
| `confirmation(A0,B1)` | `o1` also confirms A0 here; the `p1` it carried remains part of its witness. |
| An independent observation exists at `C(X0,B0)` | Its head stays `C(X0,B0)`. Sharing B0 creates no connection to the rotation. |
| No fact mentions a pair | Its head is `no-evidence`. |

**Tests:** [receiving a peer rotation][test-peer].

<a id="local-rotation"></a>

## Local rotation needs predecessor confirmation

Saving `d1`, a local A0-to-A1 decision, does not immediately establish a usable
link. An observation must confirm **A0**. It can come from B0 or from a successor
of B0 reached by a usable path of peer rotations.

```mermaid
flowchart LR
    O0["o0: B0 wrote to A0"] -->|"Confirms predecessor A0"| D1["d1: A0 → A1"]
    D1 -->|"Establishes local link"| L["C(A0,B0) → C(A1,B0)"]
    O1["Only a receipt from B0 to A1"] -->|"Confirms A1 only"| A1["No confirmation of A0"]
```

| Input | `status(d1)` | `head(C(A0,B0))` |
| --- | --- | --- |
| Only `d1`, with `source: null` | `waiting` | `unresolved`, waiting `[d1]`, missing `[]`. |
| Add `o0`, addressed to A0 | `usable` | `head C(A1,B0)`, support `[d1,o0]`. |
| Only an observation addressed to A1 | `waiting` | Still `unresolved`: receipt at the successor does not confirm the predecessor. |
| `source: o0`, but o0 is absent | `unresolved`, missing `[o0]` | `unresolved`, naming the exact missing reference o0. |
| The named o0 addresses A0, but its peer is not on a reachable peer path | `waiting` | `unresolved`. |
| The named o0 addresses another local DID | `invalid` | The decision establishes no usable link. |
| The named receipt carried a transition but has no observation here | `unresolved`, missing that receipt's observation | A source never resolves to a transition. |

With `source: null`, the model finds a qualifying observation. A named source
requires the observation of that exact receipt; another observation cannot
replace it. A chain of
unconfirmed A0-to-A1-to-A2 decisions also cannot become usable just because an
observation addresses A2 at its far end.

The declared but unestablished successor `C(A1,B0)` is also `unresolved`.
`FactStatus.waiting` describes an individual fact, while
`HeadResult.unresolved` says the query still has forward choices to account for.

**Tests:** [local rotation and confirmation][test-local].

<a id="join"></a>

## Both parties rotate: a join establishes a pair without inventing a receipt

At the starting pair, `o0` confirms A0. A saves `d1`, an A0-to-A1 decision, and
B supplies `p1`, a B0-to-B1 transition. Once both base edges are established, the
model derives two join edges:

```mermaid
flowchart LR
    C00["C(A0,B0)<br/>o0: B0 wrote to A0"] -->|"d1: local rotation"| C10["C(A1,B0)"]
    C00 -->|"p1: peer rotation"| C01["C(A0,B1)"]
    C10 -. "join: peer" .-> C11["C(A1,B1)<br/>Common head"]
    C01 -. "join: local" .-> C11
    classDef head fill:#e1f3e5,stroke:#39734a,color:#173d24
    class C11 head
```

The diamond shows where the two address changes continue together.
**It contains no receipt from B1 to A1, so A1 remains unconfirmed.**

This minimal example uses the public API. A0 and the other strings are the
abbreviations used by the core tests; the proof API requires actual did:peer:4
identifiers.

```ts
import { deriveContinuity, type ContinuityFact } from "@estoc/continuity";

const C = (localDid: string, peerDid: string) => ({ localDid, peerDid });
const facts: ContinuityFact[] = [
  { kind: "address-observed", at: C("A0", "B0"), carried: false, evidence: "o0" },
  { kind: "local-decision", at: C("A0", "B0"),
    change: { kind: "rotate", successor: "A1" }, source: null, evidence: "d1" },
  { kind: "peer-transition", at: C("A0", "B0"),
    change: { kind: "rotate", successor: "B1" }, evidence: "p1" },
];

const model = deriveContinuity(facts);
model.head(C("A0", "B0"));
model.confirmation("A1", "B1");
```

| Query | Result |
| --- | --- |
| `head` from C(A0,B0), C(A1,B0) or C(A0,B1) | All reach `C(A1,B1)`, with support `[d1,o0,p1]`. |
| `confirmation(A0,B0)` | `confirmed`, established by o0. |
| `confirmation(A1,B1)` or `confirmation(A1,B0)` | `unconfirmed`, with unusable `[]`: there is no observation addressed to A1. |
| The two join edges in `history` | `derived: true` and `usable: true`, each with support `[d1,o0,p1]`. |

A later authenticated, proof-free message from B1 to A1 supplies the missing
observation `o2`:

```mermaid
sequenceDiagram
    participant B1
    participant A1
    participant Model as Model over the new facts
    B1->>A1: Authenticated message without from_prior
    A1->>Model: o2 at C(A1,B1), carried = false
    Model-->>A1: confirmation(A1,B1) = confirmed, support [o2]
```

For `confirmation(A1,B0)`, the witness must also establish how B0 reaches B1, so
o2's support is `[d1,o0,o2,p1]`. The same observation can need different complete
witnesses for different query starting points.

**Tests:** [both parties rotate][test-join].

<a id="contexts"></a>

## Contexts establish scope; paths preserve direction

In the join example, `history(C(A0,B0))` has these two contexts:

| Name | Fixed endpoint | Members in this example | Purpose |
| --- | --- | --- | --- |
| `samePeer` | Peer B0 | C(A0,B0), C(A1,B0) | The pairs local rotations connect: where B0's changes apply. |
| `sameLocal` | Local A0 | C(A0,B0), C(A0,B1) | The pairs peer rotations connect: where A0's decisions apply. |

Each context is named by the endpoint it keeps, and follows connectivity
through the other side's links in either direction. A `path` follows usable rotations only in their forward direction.

```mermaid
flowchart LR
    C00["C(A0,B0)"] -->|"peer"| C01["C(A0,B1)"]
    C01 -->|"local join"| C11["C(A1,B1)"]
    C10["C(A1,B0)"] -->|"peer join"| C11
```

| `path(from, to)` | Result |
| --- | --- |
| C(A0,B0) → C(A1,B1) | This example selects C(A0,B0) → C(A0,B1) → C(A1,B1), with support `[d1,o0,p1]`. |
| C(A1,B1) → C(A0,B0) | `none`: context membership does not let a path reverse rotations. |
| C(A0,B1) → C(A1,B0) | `none`: belonging to the same history does not establish a directed path. |
| Known C(A0,B0) → itself | A zero-step `path`, containing only that channel, with support `[]`. |
| A pair with no evidence → a known pair | `none`. |

The graph's `peer` traversal does not cross local edges; `any` can traverse both
sides. Tests use 1,000 graph edges to check complete reachability, stopping at a
requested target and rebuilding paths on demand. The model also checks heads
and paths over 3,000 peer rotations. These are correctness examples, not
throughput guarantees.

**Tests:** [join paths and contexts][test-join], [graph reach][test-graph],
[long rotation history][test-convergence].

<a id="competition"></a>

## Repetition, competition and structural conflicts

```mermaid
flowchart LR
    subgraph SAME["Same change, more provenance"]
        direction LR
        S0["C(A0,B0)"] -->|"p1 and p2: B0 → B1"| S1["C(A0,B1)<br/>head, support [p1,p2]"]
    end
    subgraph FORK["Same context, different successors"]
        direction LR
        F0["C(A0,B0)"] -->|"p1: B0 → B1"| F1["C(A0,B1)"]
        F0 -->|"p2: B0 → B2"| F2["C(A0,B2)"]
    end
    classDef conflict fill:#fbe5e5,stroke:#b04444,color:#702525
    class F0,F1,F2 conflict
```

The edges in the "different successors" group are competing claims. `head` and
the affected `path` and `confirmation` queries return `conflict`. Arrival order
and time select no successor.

| Boundary | Result and reason |
| --- | --- |
| Two receipts both declare B0 → B1 | More support, with no additional successor or fork. |
| p1 is at C(A0,B0), p2 is at C(A1,B0), and a local link connects the pairs | Different successors still compete in the same B0 context. |
| Remove that local connection, with no other context connection between the pairs | Sharing B0 alone does not establish this competition across pairs. |
| Save both A0 → A1 and A0 → A2 at one pair, before any observation arrives | Already `competing-changes`: missing confirmation does not erase a saved fork. |
| Add a proof-free observation to a conflicted context | It cannot restore usable continuation through the conflict. |
| Another disconnected relationship also uses B0 | It keeps its own usable head. |

Two other graph shapes prevent an ordinary head:

```mermaid
flowchart LR
    subgraph CYCLE["cycle"]
        direction LR
        P0["C(A0,B0)"] -->|"p1"| P1["C(A0,B1)"]
        P1 -->|"p2"| P0
    end
    subgraph COLLISION["identity-collision"]
        direction LR
        Q0["C(A0,B0)"] -->|"local → A1"| Q1["C(A1,B0)"]
        Q0 -->|"peer → A1"| Q2["C(A0,A1)"]
        Q1 -. "join rejected" .-> BAD["C(A1,A1)<br/>Cannot be established"]
        Q2 -. "join rejected" .-> BAD
    end
```

A `cycle` returns to a pair the rotations left. An `identity-collision` would
give both endpoints the same successor DID. These are positive claims; the
resulting conflicts prevent usable paths. The local rotation in the collision
example has predecessor confirmation.

Each conflict carries its scope, the pairs a query answers `conflict` for
because of it: for competing changes the context and the successor pairs its
claims name, for a cycle its pairs, for a refused join the pair and its two
successor pairs.

**Tests:** [repeated carriers][test-peer], [competing changes][test-competition],
[observations][test-observations].

<a id="acceptance"></a>

## The same facts give the same answers, even when a head is withdrawn

```mermaid
flowchart LR
    A["replica A<br/>o0 + d1 + p1<br/>head = C(A1,B1)"] --> M["Sources meet;<br/>facts projected again"]
    B["replica B<br/>o0 + p2<br/>p2 at C(A1,B0): B0 → B2"] --> M
    M --> R["Both replicas see the same conflict<br/>p1 and p2 compete in one B0 context"]
```

Learning more facts can withdraw a previously usable head. The result still
converges: replicas holding the same facts report the same conflict. Converging
cannot undo messages that have already been sent.

`deriveContinuity` accepts the facts before deriving anything:

| Input boundary | What the tests establish |
| --- | --- |
| The same facts in any order, with any repetition | The same answers. |
| The same key, the same value | Kept once; object member order does not affect equality. |
| The same key, a different value | `InvalidFact`: one receipt or one saved decision says one thing, so no value is chosen and none is kept beside another. |
| The same change under different evidence | Separate support for one change. |
| Different string case | Different evidence is another fact, and a different DID under one key another value; the core does not normalize DIDs for the host. |
| Order of the accepted facts | Evidence, then kind, in UTF-8 byte order rather than UTF-16 or locale order. |
| Extra or inherited members, empty evidence, equal endpoints, or a successor equal to either endpoint | `InvalidFact`. |
| Missing or incorrectly typed `source` or `carried`, an ending with a successor or a source, or invalid Unicode | `InvalidFact`; a required explicit null cannot be omitted. |
| An input member is an accessor | Validation captures its value instead of reading a changing member again later. |

An invalid fact or a second value under a key rejects the whole call; nothing
is derived that skips it.

**Tests:** [accepting facts][test-accept], [validating a fact][test-validate],
[convergence and monotonicity][test-convergence].

<a id="diagnostic"></a>

## A link only the positive graph has

A conflict takes every pair its scope reaches out of usable continuity, and with
them what depends on those pairs, even beyond the scope. Here a peer fork at
C(A0,Bz) reaches C(A0,Bp). Receipt s carried a transition from C(A0,Bp) to
C(A0,B0), so neither that transition nor the observation of s is usable. The
local rotation d names s as its source: it links C(A0,B0) to C(A1,B0) in
positive history, never in usable continuity, though neither of its pairs is in
conflict.

```mermaid
flowchart LR
    Z["C(A0,Bz)<br/>fork: Bz → Bp, Bz → Bq"] -->|"f1"| P["C(A0,Bp)<br/>in the fork's scope"]
    P -. "s: carried transition, not usable" .-> C00["C(A0,B0)<br/>s: observation, not usable"]
    C00 -. "d: source = s, diagnostic" .-> C10["C(A1,B0)"]
    classDef conflict fill:#fbe5e5,stroke:#b04444,color:#702525
    class Z,P conflict
```

| Situation | Result |
| --- | --- |
| Only d makes A0 → A1 | `head(C(A0,B0))` is `conflict`. There is no usable path and no fallback to the predecessor head. |
| `p + o + i` make the same A0 → A1 usably at C(A0,B1), which p connects | They establish the head and path; d is provenance, and `status(d)` is `conflict` through its source. |
| d names a source that is absent instead | The same: a waiting claim of a change usable links make anyway does not block the head. |

Support in `history().links` is positive provenance. Even when a link has
`usable: true`, its history support can contain facts that are not usable. For a
usable witness, read the corresponding `path`, `head` or `confirmation` result.

**Tests:** [the same change elsewhere in a context][test-covered].

<a id="onward"></a>

## Onward rotations on a side branch still need an answer

Here is a harder boundary. `p + o + i` establish a usable route to A1B1: p
rotates B0 → B1, o observes B1 writing to A0, and i decides A0 → A1 at C(A0,B1).
The `d` of the previous section declares the same A0 → A1 and leaves a side
branch through C(A1,B0) in positive history.

```mermaid
flowchart LR
    C00["C(A0,B0)"] -->|"p: usable peer"| C01["C(A0,B1)<br/>o: addressed to A0"]
    C01 -->|"i: usable local"| C11["C(A1,B1)<br/>Reached by p + o + i"]
    C00 -. "d: diagnostic" .-> C10["C(A1,B0)"]
    C10 -. "diagnostic join" .-> C11
    C10 -. "w: saved A1 → A2<br/>source = missing" .-> C20["C(A2,B0)<br/>Not yet established"]
```

w is outside the original usable forward path, but it still declares an onward
choice for A1. The query must account for that choice before returning a head.

| Evidence added to the base example | `head(C(A0,B0))` | Why |
| --- | --- | --- |
| w has not been added | `head C(A1,B1)`, support `[i,o,p]` | Usable evidence establishes the same change. |
| Add w as shown | `conflict`, facts `[w]` | Only diagnostic history connects w's scope to the query; `status(w)` itself remains `unresolved` for its missing source. |
| Also add usable `scope: C(A1,B0) → C(A1,B1)` | `unresolved`, waiting `[w]`, missing `[missing]` | Its scope is established; the exact source is still missing. |
| Then supply `missing`, an observation from B0 to A1 | `head C(A2,B1)` | Both scope and confirmation prerequisites are satisfied. |
| Without adding scope, independently establish A1 → A2 at C(A1,B1) using a new observation | `head C(A2,B1)` | The same onward change has usable support; w remains provenance. |
| Instead save A1 → A3 at C(A1,B1) | `conflict` | It competes with w's A1 → A2. |

This explains why `status(fact)` and `head(pair)` can return different statuses.
The former describes the fact's own prerequisites; the latter also accounts for
ambiguity in how the claim applies to the queried continuity.

**Tests:** [the same change elsewhere in a context][test-covered],
[saved onward rotation][test-onward].

<a id="ending"></a>

## Endings terminate a context without creating an empty pair

```mermaid
flowchart LR
    subgraph EXTEND["Scope of peer B0's ending"]
        C00["C(A0,B0)<br/>e: peer ending"] -->|"Local link supported by o0 + d1"| C10["C(A1,B0)"]
    end
    CX["C(X0,B0)<br/>No context connection"]
    C00 -->|"head"| E["ended [e]"]
    C10 -->|"head"| E
```

A peer ending applies across its same-peer context, the pairs local rotations
connect while keeping that peer. A local ending applies across its same-local
context. Other pairs with no connecting evidence are unaffected.

| Combination | Result |
| --- | --- |
| B0 ending and B0 → B1 in the same B0 context | `conflict`: incompatible choices for the same side. |
| B0 → B1, followed by B1 ending | `ended`: ordinary forward history at different predecessors. |
| Local A0 ending and peer B0 → B1 | Both pairs are `ended`; there is no continuing joined head. |
| Local ending and A0 → A1 in the same A0 context | `conflict`. |
| An observation claims it carried an ending | `invalid`: an ending establishes no successor-address observation. |
| Several endings of one side, or endings of both sides | `ended`, listing every one. |
| An ending at another pair connects only through a link that is not usable, such as one leaving a pair a fork reaches | The query reports `conflict`; historical connectivity alone cannot apply the ending. |
| The same link without the fork, or another ending of the same side at the queried pair | `ended`. |

Endings retain the original pair and assertion. They create no `C(A,null)` and
do not mean a contact was deleted, a peer was blocked or an application message
was processed. `ended.endings` lists the endings without the complete context
witness across pairs.

**Tests:** [ending][test-ending], [usable scope for an ending][test-ending-scope].

<a id="dependencies"></a>

## Diagnose missing and conflicted evidence along the whole dependency chain

Assume a usable `scope` establishes C(A0,B0) → C(A0,B1). At the old pair, w
decides A0 → A1 and names receipt t as its source. At the new pair, s is the
observation of receipt t, which carried transition t from C(A0,Bp) to C(A0,B1).

```mermaid
flowchart LR
    W["w: local decision<br/>A0 → A1"] -->|"source = receipt t"| S["s: B1 wrote to A0"]
    S -->|"carried"| T["t: Bp → B1<br/>the transition of the same receipt"]
```

| State of t and other inputs | Query result |
| --- | --- |
| t is absent | `head` is `unresolved`, missing `[t]`. Diagnose the exact reference; s cannot become proof-free. |
| t is absent and B1 has a valid peer ending | `head` is `ended`; `status(w)` still exposes the missing evidence. |
| t is here and usable | w becomes usable, yielding the common head C(A1,B1). |
| A fork reaches C(A0,Bp), where t starts | `head` is `conflict`, tracing through s to the conflicted transition; `status(w)` names the fork's facts. |
| That fork and the ending are both present | Still `conflict`: relevant conflict takes precedence over an ending. |

Another subtle case uses only an observation whose carried transition is
missing. `head` can return the original pair with empty support while
`confirmation` remains `unconfirmed`, listing that observation as unusable.
**A head cannot replace an operation's exact evidence prerequisites.**

For known forward choices, the result accounts for relevant conflicts first,
then established endings, unresolved choices and finally a usable head.
`no-evidence` is reserved for an unknown pair.

**Tests:** [the full reference chain][test-dependencies],
[observations and carried transitions][test-observations].

<a id="support"></a>

## A short link can need a witness spanning several hops

o2 is a proof-free observation from B2 to A0. For d1 in B0's context to use it
as predecessor confirmation, the witness also needs the B0 → B1 → B2 peer path.

```mermaid
flowchart LR
    C00["C(A0,B0)"] -->|"p1"| C01["C(A0,B1)"]
    C01 -->|"p2"| C02["C(A0,B2)<br/>o2: addressed to A0"]
    C00 -->|"d1: local link<br/>support [d1,o2,p1,p2]"| C10["C(A1,B0)"]
```

Keeping only d1 and o2 loses the evidence that lets B2 confirm A0 in B0's
context. A usable witness includes the required peer path and the recursive
prerequisites of its links. Support need not be a minimal set.

| Returned evidence | What it establishes |
| --- | --- |
| `path.support` | Re-derives the asserted usable links under the same profile. |
| Each `confirmation.observations[n].support` | Re-derives that individual confirmation, including the transition its observation carried. |
| `head.support` | Supports the usable links leading to the head; it does not promise to replay the whole query verdict. |
| An unchanged head or zero-step path, with support `[]` | There is no rotation link to prove; this establishes no address observation. |
| Positive provenance in `history` | Explains origins and ambiguity; it is not a general usable witness. |

Keep the facts and the profile to replay a query result. Support proves no
absence of conflicts or missing evidence outside those facts. `path` selects
one deterministic path. `confirmation` lists eligible observations with one
complete witness each; it does not enumerate every alternative route to the
same observation.

**Tests:** [confirmation support across several hops][test-local],
[join witnesses and zero-step paths][test-join]. The complete replay boundary
is in the [README's query explanation](../README.md#what-the-answers-mean).

<a id="proofs"></a>

## Inspect, precheck, verify and bind are separate proof-processing stages

```mermaid
flowchart TB
    JWT["Received JWT"] --> I["inspect<br/>Read header / claims"]
    I --> P["precheck<br/>document-independent profile rules<br/>+ successor is the authenticated sender"]
    P --> D["Host retrieves issuer long form"]
    D --> V["verify<br/>profile + issuer key + signature"]
    R["Host-established receipt<br/>token / recipient / sender"] --> B["bind<br/>Check this receipt"]
    V --> B
    B --> F["Bound facts"]
```

`inspect` can successfully read a token whose signature has been tampered with.
`precheck` refuses, before the host has any issuer material, what the profile
can already decide: the algorithm, media type and critical headers, the DIDs,
the shape of the change and, given the authenticated sender, a rotation whose
successor is someone else; what it passes is still unverified, and a host that
lacks the issuer's material waits rather than rejects. `verify` applies the
same rules again, takes the authorized key from the issuer's own long-form DID
and verifies the signature. `bind` checks the exact token against the receipt
and establishes facts only when binding succeeds.

| Input boundary exercised by the tests | Result |
| --- | --- |
| Wrong JWT segment count or JSON shape, non-integer `iat`, `sub: null`, or array-valued `aud` | `form` failure. |
| A signature segment that is not base64url or not 64 bytes long | `form` failure at inspection, precheck and verification; a well-formed wrong signature is left to verification. |
| `exp` or `nbf` | Rejected: this profile evaluates no validity window, and verification reads no clock. |
| Unsupported DID method or algorithm, rotation to the issuer itself, or a rotation with an audience | `profile` failure. |
| Absent `typ`, or case variants of JWT / application/jwt | Accepted; extra whitespace, parameters and other media types are rejected. |
| Absent `b64`, or `true` with `b64` listed in `crit` | Accepted; `false`, wrong types and missing required critical-header declarations are rejected. |
| Unknown critical extension | `profile` failure at the precheck and at verification; inspection still reads the token. |
| `crit` naming a `b64` the header lacks, or listing a header twice | `form` failure at every stage. |
| An authorized JWK whose `x` is not a 32-byte Ed25519 key | `document` failure, the same as a Multikey of another type. |
| A rotation whose successor is not the authenticated sender the precheck was given | `binding` failure before any issuer material; an ending is left to `bind`. |
| A tampered signature | Passes the precheck without a verified type; `signature` failure at verification. |
| Repeated JSON claim name | The parser's last value is used; inspection and interpretation of the verified payload agree. |
| Short-form `iss` and `kid` with the matching retained long form | Accepted; presented spellings and canonical short forms are both retained. |
| Wrong, malformed or hash-mismatched issuer document, or a key not authorized for authentication | `document` failure; a caller-assembled document cannot substitute another key. |
| A qualifying Multikey, JWK or embedded authentication method | Can verify an Ed25519 signature; a key authorized only for keyAgreement cannot. |
| Altered signed payload, another signing key or incorrect signature bytes | `signature` failure. |
| A different receipt token, a sender other than the rotation successor, or an ineligible recipient | Binding `mismatch`, producing no fact. |
| A rotation bound to its receipt | A transition and an observation of the successor, both under the receipt's reference; a bound ending yields the transition alone. |

### A verified ending can still be unbound

```mermaid
flowchart TD
    V["Verified ending<br/>sub is absent"] --> A{"Signed aud present?"}
    A -->|"No; basic receipt checks pass"| U["unbound<br/>Retain proof, no ending fact"]
    A -->|"Yes"| R{"aud matches recipient<br/>and receipt is anonymous?"}
    R -->|"Yes, and exact token matches"| F["bound<br/>Peer ending at C(recipient, issuer)"]
    R -->|"No"| M["mismatch"]
```

`sender: null` is the host's assertion of an anonymous receipt, requiring the
plaintext to contain no `from`. Signed audience is an extension of this
package's profile. A valid basic ending token alone does not identify which
recipient's relationship it ends. Ending binding produces no address observation.

### Creation verifies the signer's output too

```mermaid
flowchart LR
    R["ProofRequest"] --> P["Check request / issuer method"]
    P --> S["Host-held signer<br/>Sign JWS signing input"]
    S --> V["Verify against issuer evidence"]
    V --> O["VerifiedFromPrior"]
```

An inconsistent request is rejected before signing. An unauthorized method,
another key or invalid signature bytes cannot produce a verified proof. The
signer can hold a non-exportable key. Creating a proof saves no decision and
sends no message.

**Tests:** [inspect][test-inspect], [precheck][test-precheck],
[verify][test-verify], [bind][test-bind], [create][test-create].

<a id="host"></a>

## Queries and commits must use a valid revision

This is an integration requirement from the [host contract](../README.md#host-contract).
Core tests demonstrate that new facts can change an answer. The core has
no database transaction and cannot validate the atomicity of a host's commit.

```mermaid
sequenceDiagram
    participant H as Host
    participant S as Sources / projection
    participant M as Continuity model
    H->>S: Read complete revision r
    H->>M: Derive over revision r and check prerequisites
    M-->>H: head / path / confirmation
    S->>S: New evidence produces revision r+1
    H->>S: Check revision before commit
    S-->>H: Revision has changed
    H->>M: Re-derive and re-evaluate complete r+1
    M-->>H: Answer may now be conflict
```

Validation and the state commit must use the same valid revision. The host can
use a transaction, lock or optimistic version check. Projection completeness,
commit consistency and successor-allocation coordination across replicas each
have their own role: a local lock cannot prevent another offline replica from
saving a different successor.

Head, path and confirmation also do not decide key, route, block, admission or
ACK policy. Those decisions remain with the host that uses the results.

## Find the corresponding tests

| Question | Illustrated section | Test coverage |
| --- | --- | --- |
| How do address changes differ from address confirmation? | [Peer rotation](#peer-rotation), [local rotation](#local-rotation), [join](#join) | Receiving a peer rotation; local rotation and confirmation; both parties rotate. |
| Where can a path go, and which pairs share a scope? | [Contexts](#contexts), [support](#support) | Graph reach; join paths and history; witnesses spanning several hops. |
| When is there no longer a unique head? | [Competition](#competition), [links only the positive graph has](#diagnostic), [onward rotations](#onward) | Competing changes; the head across a context. |
| Why does an ending or missing evidence take precedence? | [Endings](#ending), [dependency chains](#dependencies) | Ending; observations; the head across a context. |
| Which facts are accepted, and how can replicas converge to a conflict? | [Acceptance](#acceptance) | Accepting facts; validating a fact; convergence and monotonicity. |
| Which inputs are rejected between a token and a fact? | [Proofs](#proofs) | Inspect; precheck; verify; bind; create. |

[test-peer]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L39
[test-local]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L83
[test-join]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L164
[test-competition]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L215
[test-ending]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L289
[test-observations]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L342
[test-ending-scope]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L387
[test-covered]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L406
[test-onward]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L425
[test-dependencies]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L449
[test-convergence]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/model.test.ts#L472
[test-graph]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/graph.test.ts#L6
[test-accept]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/accept.test.ts#L14
[test-validate]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/accept.test.ts#L65
[test-inspect]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/from-prior.test.ts#L76
[test-precheck]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/from-prior.test.ts#L105
[test-verify]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/from-prior.test.ts#L195
[test-bind]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/from-prior.test.ts#L355
[test-create]: https://github.com/estoc-dev/estoc/blob/cd87f930f7ac6c7ff35c11cde91497a2e3e83537/packages/continuity/test/from-prior.test.ts#L406
