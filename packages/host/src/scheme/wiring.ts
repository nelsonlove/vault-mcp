// Wiring for the scheme Inbox pane (jd-dashboard fold, Stage B). Read-only
// chrome: no MCP tool, no write capability, no gesture gate — the same trust
// boundary as Obsidian's own file explorer, which is why (unlike an MCP tool's
// `ctx.notes()`) the Inbox pane reads `app.vault` directly rather than going
// through the MCP path-visibility allowlist (guard.ts's `visiblePaths`). That
// allowlist bounds what an MCP-connected AGENT can reach; a human's own sidebar
// in their own Obsidian is not that boundary.
//
// The Drift pane (Stage C) was wired here beside it until 2026-10-14. It runs
// the conformance engine and nothing else, so it left with the conformance rail
// for the vaultmcp-conformance satellite (packages/conformance/src/drift-pane.ts),
// which registers its own view, ribbon and command. The Inbox pane reads the
// scheme registry and stays with the scheme surface, here in the host.
//
// The Inbox pane DOES still respect a configured scheme instance's
// `excludedRoots`, though — that is a "what does this vault's addressing
// scheme consider live JD territory at all" judgment (config is not
// hardwired, Nelson's ruling — see tools-scheme.ts's callers of
// `excludeRoots`), independent of the agent-facing allowlist. A
// vault-relative folder an instance is configured to never resolve/list/
// claim (e.g. an archive tree reusing a live spine's addresses) should not
// show up as a "real" inbox here either. Excluded from every configured
// instance's union, not just one — with several instances configured
// differently, any of them saying "this isn't live JD territory" is reason
// enough to leave it out of a human-facing rollup, even though only one
// instance's grammar is what actually finds the inbox folders in the first
// place (inbox.ts's own regexes, JD-specific — see its header for why that
// isn't threaded through ScopeProvider itself).
//
// LIVE MOUNT/UNMOUNT (fixes governor#286, filed against the original,
// onload-only shape of this file): the view + ribbon register on a
// shared child `Component` (`plugin.addChild`) that `wireSchemePanes`
// returns — a live unmount is `plugin.removeChild(it)`, which detaches any
// open leaves, unregisters the view type, and removes the ribbon
// element. This mirrors `governor/wiring/wiring.ts`'s `wireGovernance` exactly
// (the fix pattern #286 pointed at, itself from #200) — a plugin-toggle
// flip is no longer a "nothing happened until I reload" surprise, and
// disabling the module no longer leaves a registered view type + a live
// leaf pointing at a torn-down mount. Commands are the one piece that stays
// OUTSIDE the component: Obsidian's public API has no `removeCommand`, so
// (matching every other wiring file in this plugin — none live-unregisters
// a command) they register once, at onload, as a `checkCallback` on the
// CURRENT state (module on and a scheme configured) — while it is off the
// command is simply not offered, so it never tries to open an unregistered
// view type.

import { type App, Component, type Plugin, type ViewCreator, TFolder } from "obsidian";
import { makeRegistry, excludeRoots, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import { INBOX_VIEW_TYPE, InboxPaneView, type InboxPaneController } from "./inbox-pane.js";

function revealFolder(app: App, path: string): void {
  const folder = app.vault.getAbstractFileByPath(path);
  if (!(folder instanceof TFolder)) return;
  const fileExplorer = app.workspace.getLeavesOfType("file-explorer")[0];
  if (!fileExplorer) return;
  app.workspace.revealLeaf(fileExplorer);
  // No public Obsidian API for "select this folder in the file tree" —
  // reaching the built-in file-explorer view's internal method (a typed
  // structural cast, not `any` — same reach, tighter typing than the
  // original jd-dashboard plugin's `(view as any).revealInFolder?.(...)`).
  (fileExplorer.view as unknown as { revealInFolder?: (f: TFolder) => void }).revealInFolder?.(folder);
}

/** Best-effort access to Obsidian's internal view registry — the ONE thing
 *  `plugin.registerView` only tears down at plugin unload, so a LIVE
 *  unmount must unregister the type itself (its public wrapper offers no
 *  un-register). Duplicated from governor/wiring/wiring.ts's own private helper
 *  of the same name/shape, rather than exported and shared, matching this
 *  plugin's precedent of small per-file helpers. An Obsidian
 *  build without it degrades to "leave the type registered", handled by the
 *  reuse-on-duplicate try/catch below. */
function viewRegistryOf(plugin: Plugin): { unregisterView(type: string): void } | undefined {
  const vr = (plugin.app as unknown as { viewRegistry?: { unregisterView?: (type: string) => void } }).viewRegistry;
  return typeof vr?.unregisterView === "function" ? (vr as { unregisterView(type: string): void }) : undefined;
}

async function activateView(app: App, viewType: string): Promise<void> {
  const existing = app.workspace.getLeavesOfType(viewType);
  if (existing.length > 0) { app.workspace.revealLeaf(existing[0]); return; }
  const leaf = app.workspace.getRightLeaf(false);
  if (!leaf) return;
  await leaf.setViewState({ type: viewType, active: true });
  app.workspace.revealLeaf(leaf);
}

export interface WireSchemePanesOpts {
  /** The vault's configured scheme instances, read fresh per call — mirrors
   *  server.ts's own `schemes: () => makeRegistry(...)` (a cheap, pure,
   *  rebuild-don't-cache factory), so a settings-tab edit to `excludedRoots`
   *  takes effect on the Inbox pane's next refresh without a plugin reload. */
  getSchemes: () => SchemeInstanceConfig[];
}

/** One pane's registration: view + teardown hook + ribbon, all landing on
 *  the shared `component`. Isolated in its own try/catch (see
 *  `wireSchemePanes`'s doc comment) so a failure setting up ONE pane cannot
 *  orphan the other's already-successful registration with no reference
 *  left to tear it down. */
function wirePane(plugin: Plugin, component: Component, viewType: string, label: string, icon: string, factory: ViewCreator): void {
  const app = plugin.app;
  try {
    plugin.registerView(viewType, factory);
  } catch (e) {
    console.warn(`[vault-mcp] ${viewType} view type already registered — reusing it`, e);
  }
  component.register(() => {
    for (const leaf of app.workspace.getLeavesOfType(viewType)) leaf.detach();
    try { viewRegistryOf(plugin)?.unregisterView(viewType); }
    catch (e) { console.warn(`[vault-mcp] ${viewType} view unregister failed`, e); }
  });
  const ribbon = plugin.addRibbonIcon(icon, label, () => void activateView(app, viewType));
  component.register(() => ribbon.remove());
}

/**
 * Mount the scheme panes (today the Inbox pane alone) on one shared child
 * Component, gated by the "scheme" module toggle — one `removeChild` call is a
 * complete teardown.
 *
 * Each pane's registration is isolated (`wirePane`'s own try/catch) rather
 * than left to a single try/catch around this whole function (which is what
 * the CALLER, `applySchemePanesMount`, still wraps this in too) — a mount
 * cycle is live and REPEATABLE (toggle off/on, off/on...), so a failure
 * setting up one pane must not orphan another pane's ribbon/view with no
 * surviving reference to tear it down. The isolation stays although one pane
 * is left: it is what keeps a second pane added here safe.
 */
export function wireSchemePanes(plugin: Plugin, opts: WireSchemePanesOpts): Component {
  const app = plugin.app;
  const component = new Component();
  plugin.addChild(component);

  try {
    const inboxController: InboxPaneController = {
      notes: () => {
        const notes = app.vault.getMarkdownFiles().map((f) => f.path);
        const roots = makeRegistry(opts.getSchemes())
          .instances()
          .flatMap((inst) => inst.excludedRoots ?? []);
        return excludeRoots(notes, roots.length ? roots : undefined);
      },
      revealFolder: (path) => revealFolder(app, path),
    };
    wirePane(plugin, component, INBOX_VIEW_TYPE, "Open JD inboxes", "inbox", (leaf) => new InboxPaneView(leaf, inboxController));
  } catch (e) {
    console.error("[vault-mcp] scheme inbox pane wiring failed", e);
  }

  return component;
}

/** Registered once, regardless of live mount state — Obsidian's public API
 *  has no `removeCommand`, so (matching every other wiring file in this
 *  plugin) these are never live-unregistered. Each is a `checkCallback` on
 *  `isEnabled()` (the module on AND a scheme configured), so while there is
 *  no scheme the command is not offered in the palette at all, and it appears
 *  the moment one is added — no reload. */
export function registerSchemeCommands(plugin: Plugin, isEnabled: () => boolean): void {
  const app = plugin.app;
  plugin.addCommand({
    id: "scheme-inbox-open",
    name: "Scheme: open JD inboxes",
    checkCallback: (checking: boolean) => {
      if (!isEnabled()) return false;
      if (!checking) void activateView(app, INBOX_VIEW_TYPE);
      return true;
    },
  });
}
