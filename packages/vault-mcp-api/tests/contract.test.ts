// tests/contract.test.ts — the reason this SDK lives in the monorepo (#86):
// pin the SDK's declared boundary (apiVersion + registration shapes) to what
// the HOST actually accepts, by importing the host's real source
// (packages/host/src/mcp/external-tools.ts). If either side drifts, this
// file fails to type-check or these tests fail — the contract cannot drift
// silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { publishTools, API_VERSION_MIN, API_VERSION_DECLARATIONS, hostApiSupported, partial, isPartial, PARTIAL_BRAND } from "../src/index.js";
import type {
  VaultMcpApi as SdkVaultMcpApi,
  ExternalToolSpec as SdkExternalToolSpec,
  JsonSchemaObject as SdkJsonSchemaObject,
  CallContext as SdkCallContext,
  ProtectionDeclaration as SdkProtectionDeclaration,
  SyncDeclaration as SdkSyncDeclaration,
} from "../src/index.js";
import {
  ExternalToolRegistry,
  sanitizeOwnerId,
  PARTIAL_BRAND as HOST_PARTIAL_BRAND,
  isPartialEnvelope as hostIsPartialEnvelope,
  type VaultMcpApi as HostVaultMcpApi,
  type ExternalToolSpec as HostExternalToolSpec,
  type CallContext as HostCallContext,
  type ProtectionDeclaration as HostProtectionDeclaration,
  type SyncDeclaration as HostSyncDeclaration,
} from "../../host/src/mcp/external-tools.js";
import type { JsonSchemaObject as HostJsonSchemaObject } from "../../host/src/mcp/json-schema-to-zod.js";

// ── Type-level contract, checked by `tsc -p tsconfig.tests.json` ─────────────
// (the package's test script runs it).
//
// The api SURFACE must agree in both directions; the SPEC/SCHEMA relation is
// deliberately one-directional. The SDK's JsonSchemaObject keeps `properties`
// as Record<string, unknown> — WIDER than the host's declared
// Record<string, JsonSchemaProperty> subset — because the host's stated
// contract (json-schema-to-zod.ts) is that constructs outside the subset
// degrade to z.unknown() rather than being rejected; the real acceptance gate
// is the host's runtime validation in registerTools, exercised by the runtime
// tests below. So the pinned direction is: everything the HOST declares
// acceptable must be expressible through the SDK's types (Host → SDK). If the
// host ever narrows or reshapes its boundary, these lines stop compiling.

type Assignable<A, B> = [A] extends [B] ? true : false;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// NOTE: method syntax makes registerTools parameter-BIVARIANT,
// so _api alone would miss parameter drift — the direct _spec/_schema pins
// below are what carry that load.
// Since #402 step A the SDK's apiVersion is a FLOOR (`number`, >= API_VERSION_MIN)
// while the host's stays a LITERAL LEVEL, so the api surface is pinned in
// three parts: everything BUT apiVersion mutually assignable; the host's
// declared api satisfying the SDK's (Host → SDK only — the reverse is the
// point of a floor); and the host still declaring a literal level, because
// the floor design depends on the host saying WHICH members it carries — a
// host that widened its own type to `number` would pass the first two pins
// and say nothing. A host bump to 2 lands in THIS file on purpose, as the
// two fixtures typed `HostVaultMcpApi` with `apiVersion: 1` (hostWorld and the
// floor test): a one-line edit each, and the "declared apiVersion meets the
// floor" runtime test then proves the SDK accepts the new level.
const _api: MutuallyAssignable<Omit<SdkVaultMcpApi, "apiVersion">, Omit<HostVaultMcpApi, "apiVersion">> = true;
const _apiHostSatisfiesSdk: Assignable<HostVaultMcpApi, SdkVaultMcpApi> = true;
const _hostDeclaresALevel: number extends HostVaultMcpApi["apiVersion"] ? false : true = true;
const _spec: Assignable<HostExternalToolSpec, SdkExternalToolSpec> = true;
const _schema: Assignable<HostJsonSchemaObject, SdkJsonSchemaObject> = true;
// The apiVersion-2 members, pinned in BOTH directions (design §6, the way
// `guardedTerritories` is below; #396 showed `MutuallyAssignable` is blind to an
// optional member, and the handler's `ctx` IS optional): the context type,
// and the handler's second parameter, which is where the context crosses.
const _ctx: MutuallyAssignable<SdkCallContext, HostCallContext> = true;
type SdkHandlerCtx = Parameters<Required<SdkExternalToolSpec>["handler"]>[1];
type HostHandlerCtx = Parameters<Required<HostExternalToolSpec>["handler"]>[1];
const _handlerCtx: MutuallyAssignable<SdkHandlerCtx, HostHandlerCtx> = true;
// `MutuallyAssignable` is BLIND to an optional member: a type missing an optional
// property is assignable both ways, so deleting `guardedTerritories?` from either
// side passes `_api` silently. Pin its presence and signature explicitly in both
// directions — `Required<T>` makes the optionality irrelevant, so a dropped or
// drifted member is a type error here rather than a green suite.
const _gtHostToSdk: Required<SdkVaultMcpApi>["guardedTerritories"] =
  null as unknown as Required<HostVaultMcpApi>["guardedTerritories"];
const _gtSdkToHost: Required<HostVaultMcpApi>["guardedTerritories"] =
  null as unknown as Required<SdkVaultMcpApi>["guardedTerritories"];
// The apiVersion-3 declarations (#550), pinned in BOTH directions member by
// member, because each is optional on the spec and `MutuallyAssignable` is blind
// to an optional member: a field dropped or reshaped on either side is a type
// error here.
const _protection: MutuallyAssignable<SdkProtectionDeclaration, HostProtectionDeclaration> = true;
const _sync: MutuallyAssignable<SdkSyncDeclaration, HostSyncDeclaration> = true;
const _specProtection: MutuallyAssignable<Required<SdkExternalToolSpec>["protection"], Required<HostExternalToolSpec>["protection"]> = true;
const _specSync: MutuallyAssignable<Required<SdkExternalToolSpec>["sync"], Required<HostExternalToolSpec>["sync"]> = true;
const _specPaths: MutuallyAssignable<Required<SdkExternalToolSpec>["paths"], Required<HostExternalToolSpec>["paths"]> = true;
void [_api, _apiHostSatisfiesSdk, _hostDeclaresALevel, _spec, _schema, _gtHostToSdk, _gtSdkToHost, _ctx, _handlerCtx, _protection, _sync, _specProtection, _specSync, _specPaths];

// ── Runtime contract: the real SDK against the real host registry ────────────
// Mirrors how packages/host/src/main.ts exposes the api object
// (apiVersion: 1 wrapping an ExternalToolRegistry instance).

function hostWorld() {
  const registry = new ExternalToolRegistry();
  const api: HostVaultMcpApi = {
    apiVersion: 3,
    registerTools: (owner, tools) => registry.registerTools(owner, tools),
  };
  const app = {
    workspace: {
      on: () => ({}),
      offref: () => {},
      trigger: () => {},
    },
    // Mounted under the host's CURRENT plugin id (0.12.0+). The legacy
    // `vault-mcp` id is covered in publish-tools.test.ts.
    plugins: { plugins: { governor: { api } } },
  };
  const plugin = { app, manifest: { id: "contract-probe" } } as never;
  return { registry, plugin };
}

test("publishTools registers through the real host registry; zod shape survives host validation", async () => {
  const { registry, plugin } = hostWorld();
  publishTools(plugin, [{
    name: "echo",
    description: "contract probe",
    inputSchema: { text: z.string().describe("what to echo") },
    readOnly: true,
    destructive: false,
    handler: async (args) => ({ echoed: args.text }),
  }]);
  const entries = registry.entries();
  assert.equal(entries.length, 1);
  // Published name is `${sanitizeOwnerId(id)}_${name}` — the naming the SDK documents.
  assert.equal(entries[0].toolName, `${sanitizeOwnerId("contract-probe")}_echo`);
  assert.equal(entries[0].ownerId, "contract-probe");
  // The SDK's zod→JSON Schema conversion produced something the host's F8
  // validation accepted (registerTools would have thrown otherwise); check shape.
  const schema = entries[0].spec.inputSchema;
  assert.ok(schema);
  assert.equal(schema.type, "object");
  assert.equal((schema.properties?.text as { type?: string })?.type, "string");
  assert.deepEqual(schema.required, ["text"]);
  // Annotation hints crossed intact.
  assert.deepEqual(entries[0].spec.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
  });
  // The handler crossed as a callable and round-trips plain JSON.
  assert.deepEqual(await entries[0].spec.handler({ text: "hi" }), { echoed: "hi" });
});

test("host rejects a raw zod schema at the boundary — the SDK's conversion is load-bearing", () => {
  const { registry } = hostWorld();
  assert.throws(
    () => registry.registerTools("contract-probe", [{
      name: "bad",
      description: "zod must not cross the plugin boundary",
      inputSchema: z.object({ x: z.string() }) as unknown as HostJsonSchemaObject,
      handler: () => ({}),
    }]),
    /plain JSON Schema/,
  );
});

test("readOnly omitted ⇒ host sees a mutating tool (readOnlyHint false)", () => {
  const { registry, plugin } = hostWorld();
  publishTools(plugin, [{ name: "mutator", description: "d", handler: () => ({}) }]);
  const [entry] = registry.entries();
  assert.equal(entry.spec.annotations?.readOnlyHint, false);
});

// ── #402 step A: the floor and the envelope against the real host shape ──────

test("the host's declared apiVersion (3) meets the SDK's floor (1): a host bump lands here as a fixture edit, on purpose", () => {
  const { registry } = hostWorld();
  void registry;
  const api: HostVaultMcpApi = { apiVersion: 3, registerTools: () => () => {} };
  assert.equal(API_VERSION_MIN, 1, "the floor stays 1: a host at 1 is still a host");
  assert.equal(hostApiSupported(api), true, "the host at 3 meets the floor");
  assert.ok(api.apiVersion >= API_VERSION_DECLARATIONS, "the host carries the write declarations");
  assert.equal(hostApiSupported({ apiVersion: 2 }), true, "a newer host registers");
  assert.equal(hostApiSupported({ apiVersion: 0 }), false);
  assert.equal(hostApiSupported({ apiVersion: "1" }), false, "a string is not a version");
  assert.equal(hostApiSupported({}), false);
  assert.equal(hostApiSupported(null), false);
});

test("a partial result crosses the real host registry as the branded object, unaltered by registration (the host's own external-tools test pins what a v2 host then makes of it; the v1 wrapping is no longer observable here)", async () => {
  const { registry, plugin } = hostWorld();
  publishTools(plugin, [{ name: "half", description: "d", handler: () => partial({ done: ["a"] }, "b was unreadable") }]);
  const entry = registry.entries().find((t) => t.toolName.endsWith("_half"));
  assert.ok(entry, "registered");
  const r = (await entry!.spec.handler({})) as Record<string, unknown>;
  assert.equal(isPartial(r), true);
  assert.equal(r[PARTIAL_BRAND], "partial");
  assert.deepEqual(r.data, { done: ["a"] });
  assert.equal(r.message, "b was unreadable");
});

test("the brand is spelled the same on both sides, and the two predicates agree on every shape — the host re-spells them under its layering rule", () => {
  assert.equal(HOST_PARTIAL_BRAND, PARTIAL_BRAND);
  const shapes: unknown[] = [
    partial({ a: 1 }, "m"),
    { [PARTIAL_BRAND]: "partial", data: { a: 1 }, message: "m" },
    { [PARTIAL_BRAND]: "partial", data: ["a"], message: "m" },
    { [PARTIAL_BRAND]: "partial", data: {}, message: "  " },
    { [PARTIAL_BRAND]: "partial", data: {} },
    { [PARTIAL_BRAND]: "full", data: {}, message: "m" },
    { data: { nested: partial({ x: 1 }, "inner") } },
    "partial", null, undefined, 3, [partial({ a: 1 }, "m")],
  ];
  for (const s of shapes) assert.equal(hostIsPartialEnvelope(s), isPartial(s), JSON.stringify(s));
});

// ── apiVersion 3: the write declarations cross intact and the host validates them (#550) ──

test("a v3 declaration crosses the real host registry intact and is frozen on the entry", () => {
  const { registry, plugin } = hostWorld();
  publishTools(plugin, [{
    name: "assign",
    description: "move a note to the next free address",
    inputSchema: { path: z.string(), dry_run: z.boolean().optional() },
    protection: { arg: "dry_run", values: { true: "exempt" }, otherwise: "key" },
    sync: { kind: "structure", strictStatus: true, destinationUnnamed: true },
    paths: ["path"],
    handler: () => ({}),
  }]);
  const [entry] = registry.entries();
  // The host keeps the value map without a prototype (#553 review 2), so the expected map has none either.
  assert.deepEqual(entry.declaration, {
    protection: { arg: "dry_run", values: Object.assign(Object.create(null), { true: "exempt" }), otherwise: "key" },
    sync: { kind: "structure", strictStatus: true, destinationUnnamed: true },
    paths: ["path"],
  });
  assert.ok(Object.isFrozen(entry.declaration));
});

test("a malformed v3 declaration is refused by the real host: publishTools registers nothing and the host throws", () => {
  const { registry, plugin } = hostWorld();
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    publishTools(plugin, [
      { name: "fine", description: "d", handler: () => ({}) },
      { name: "bad", description: "d", inputSchema: { path: z.string() }, sync: { kind: "structure" }, paths: ["path"], handler: () => ({}) },
    ]);
  } finally {
    console.error = orig;
  }
  assert.equal(registry.entries().length, 0, "atomic: a malformed spec registers nothing");
  assert.match(String((errors[0] as unknown[])[1]), /must also declare protection/);
});

test("a v2 spec (no declaration) registers with no declaration on the entry", () => {
  const { registry, plugin } = hostWorld();
  publishTools(plugin, [{ name: "plain", description: "d", inputSchema: { path: z.string() }, handler: () => ({}) }]);
  assert.equal(registry.entries()[0].declaration, undefined);
  assert.equal("protection" in registry.entries()[0].spec, false);
});
