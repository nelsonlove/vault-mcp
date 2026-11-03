# Observations and replay

Governor records what crossed its own boundary. It can show what it returned to an agent and what it observed changing. It does not claim to reconstruct the model's private reasoning or information obtained from another system.

## The guarantee

For a replayable operation, Governor can reproduce the exact Governor response available to the caller together with:

- the registered action and version;
- the surface used;
- Governor-derived actor, connection, session, and mandate bindings;
- normalized request and effective scope;
- the vault/Git state from which the response was produced;
- result ordering, exclusions, truncation, and unavailable sources;
- the exact returned payload or its content-addressed local object; and
- subsequent operation, effect, verification, proposal, and standing links.

This proves what Governor returned. It does not prove that a client displayed every byte, that a model attended to it, or that the model interpreted it correctly.

## Three capture levels

### Ephemeral

Governor creates an in-memory operation envelope, applies scope and policy, returns the result, and retains no replayable response.

Use it for low-information plumbing that neither reveals substantive vault content nor supports later governed work, such as:

- connection handshake;
- action/capability discovery;
- dependency and bridge health without content;
- internal index refresh;
- focusing an already-open pane;
- switching reading/editing view; and
- opening a user-named note without returning its content.

An ephemeral observation cannot support a proposal, verifier result, cohort, mandate admission, or standing transition.

### Evidence

Governor retains the operation identity, normalized request digest, effective-scope digest, source identities and revisions, response digest, result shape, ordering, omissions, truncation, availability, and timing. It does not promise exact payload playback.

Use it for inventory and diagnostic operations where identities and state are sufficient, such as a large candidate list whose bodies were not used for judgment.

Evidence-only observations may support deterministic selection only when the action contract names the retained fields as sufficient. They cannot support a content judgment whose source bytes were discarded.

### Replayable

Governor retains or content-addresses the exact response payload plus the evidence fields above. Playback returns that historical envelope rather than silently recomputing a current answer.

Use it for:

- note bodies or excerpts used to make a substantive decision;
- policy, schema, vocabulary, and authority sources;
- diffs and previews used to choose a mutation;
- search or Base results used to select governed targets;
- content supplied to a verifier; and
- any observation named as support for a proposal or admission.

## Defaults

| Context | Default |
|---|---|
| Governed session, substantive vault content | Replayable |
| Governed session, deterministic identity-only inventory | Evidence when the action proves retained fields sufficient |
| Ad hoc content read outside a governed session | Evidence unless the user or policy enables replayable capture |
| Plumbing, connection, availability, and UI navigation | Ephemeral |
| Verification or authority input | Replayable |

A policy may require a stronger level. A caller cannot request a weaker level when the action, mandate, verifier, or authority path requires durable evidence.

## Observation record

```ts
type ObservationV1 = {
  schema: "governor.observation/v1";
  id: string;
  operationId: string;
  action: { id: string; version: string };
  capturedAt: string;
  level: "evidence" | "replayable";
  actorBinding: string;
  sessionId: string | null;
  mandateId: string | null;
  normalizedRequestDigest: string;
  effectiveScopeDigest: string;
  sourceState: Array<{
    identity: string;
    path: string | null;
    revision: string | null;
    contentDigest: string | null;
  }>;
  result: {
    digest: string;
    payloadObject: string | null;
    orderMaterial: boolean;
    truncated: boolean;
    excludedCount: number | null;
    unavailable: string[];
  };
};
```

The versioned serialized schema and canonical digest rules own exact bytes. Paths appear only when disclosed by scope and required for interpretation.

## Dependency rule

A durable mutation, proposal, verification, or authority operation names the observation ids on which it depends. Governor revalidates that:

- each observation belongs to the same authorized session or an explicitly admitted source;
- the action permitted its use;
- capture level is sufficient for the asserted predicate;
- source identity and relevant content still match or the plan handles staleness;
- scope and mandate covered the observation when it was made; and
- no required source was unavailable, omitted, or truncated.

If an agent bases a requested mutation on an ephemeral read, Governor re-observes the relevant state durably before planning or executing. It never promotes an ephemeral result retroactively by claiming bytes it did not retain.

## Read-access enforcement

The operation kernel enforces read access before content or derived information is exposed:

1. resolve the registered action and surface;
2. derive actor, connection, session, and mandate bindings;
3. compute the effective scope from human settings and narrower active bounds;
4. resolve stable references only over visible candidates, and refuse the retired scheme-ref path form;
5. filter enumerations before reading bodies or computing counts;
6. refuse actions whose discovery cannot be bounded honestly;
7. execute the read adapter;
8. redact or exclude data not declared by the action contract; and
9. capture the resulting observation at the required level.

An action's availability does not widen scope. A mandate may narrow read access for its work; it cannot exceed the connection's human-chosen boundary.

## Playback

Playback is historical inspection, not re-execution. It shows:

- what was requested in normalized form;
- which scope and source state applied;
- the exact historical result when replayable;
- which later operations cited it;
- what effects Governor attempted and observed;
- which verification and authority claims followed; and
- which current sources have since changed or disappeared.

Playback must label historical paths, properties, availability, and content as historical. It must not present them as the current vault state.

## Storage and privacy

Replayable payloads can contain sensitive note bodies, excerpts, query rows, properties, paths, and historical material. They are stored locally in Governor-owned, content-addressed operational storage outside the ordinary Obsidian Sync file set.

When exact note bytes already exist in the configured local Git history scope, an observation may reference that object rather than duplicate it. Derived response envelopes, excerpts, ordering, exclusions, and availability still require their own object when exact playback depends on them.

Observation capture does not silently expand the human-chosen Git history scope. When a replayable source is outside that scope, Governor uses the separate observation store and its disclosed retention boundary rather than adding the source to Git. If the human's observation-retention boundary excludes the required payload, the operation is refused or downgraded only when no governed dependency needs exact playback.

Observation payloads do not enter the portable attestation ledger. Attestations may name observation digests and predicates but omit note bodies.

## Retention, export, and deletion

The user controls observation retention separately from connection scope:

- ephemeral material disappears at operation completion;
- evidence records follow the operation-journal retention policy;
- replayable payloads follow the configured governed-session/history retention policy;
- active proposals, verification, admission, incident holds, and standing dependencies may prevent unsafe pruning;
- export includes schema versions, objects, manifests, and integrity digests; and
- deletion reports which replay, recovery, or standing explanations will become unavailable.

Pruning evidence does not rewrite historical authority claims. It may make a claim locally unverifiable, which Governor reports explicitly.

## External session traces

A compatible client may attach an external transcript or trace reference to a session or operation. Governor records the reference and its declared digest/provenance as untrusted external evidence.

Governor does not ingest or guarantee complete model prompts, hidden reasoning, web browsing, messages, or non-Governor tool results. The client remains responsible for those records and their privacy policy.

## Failure behavior

- Required replay storage unavailable → refuse a proposal-producing or authority-supporting operation.
- Evidence-only storage unavailable for an ordinary read → return the read with a visible degraded-capture warning only when policy permits.
- Payload digest mismatch → mark the observation corrupt and block dependent verification/admission.
- Source changed after observation → preserve the historical observation and mark dependent plans stale.
- Playback object missing → show the evidence record and `payload unavailable`; never recompute current data as historical output.
- Scope policy changed → preserve the historical scope digest; current playback display must still obey the reviewing user's present authorization.

## Non-claims

Governor does not claim:

- to know what a model attended to or believed;
- to capture information obtained outside Governor;
- deterministic reproduction of a model decision;
- indefinite retention;
- secrecy from same-user compromise; or
- that observation evidence establishes correctness or authority by itself.
