// The Drift pane — a sidebar rollup of the scheme pack's NEW conformance
// findings (not already-accepted debt), grouped by check. Ported from
// obsidian-jd-dashboard's DriftPanelView (src/views/drift-panel.ts) as part of
// the jd-dashboard fold, Stage C, where it lived in the host beside the scheme
// Inbox pane. It moved to this satellite with the conformance rail (2026-10-14):
// it was always a conformance view — it runs `runConformance` through
// obsidian-drift-source.ts and nothing else — while the Inbox pane, which reads
// the scheme registry, stayed in the host with the rest of the scheme surface.
// READ-ONLY: it never writes anything, it only runs the conformance engine and
// renders the result. Click a row to open the note.
//
// The view type changed with the move (`vault-mcp-scheme-drift` →
// `vaultmcp-conformance-drift`), because a view type is plugin-owned: a saved
// workspace that held the old leaf drops it once, and the command and ribbon
// open the new one.
//
// Deliberately NOT ported: the original's one-click "fix" buttons
// (`fixSingleFrontmatter`/`createSingleStub`) write directly via
// `app.vault.process`/`app.vault.create`, bypassing the host's guard/journal/
// queue discipline entirely. Routing a human-gesture button click through that
// pipeline correctly (matching the host's `obsidian_refile_address`/
// `obsidian_renumber_address` MCP tools' own semantics, but for a UI click
// rather than an MCP call) is real design work in its own right. Named
// follow-up, not a silent drop. Also not ported: "missing stubs" scanning
// (`findMissingStubs`/`createSingleStub` for absent standard-zero notes) —
// that reads the OLD `jdex`/jd-index.yaml registry, out of scope per the
// fold's design doc (the "Not ported" table).
//
// Refresh is manual-button-only, unlike the original (which auto-rescanned,
// debounced, on every vault create/delete/rename/metadata-change). The
// original's scan was a cheap in-memory pass over already-cached
// TFile/metadataCache state; this one runs the full conformance engine,
// which reads the vault from DISK (buildSnapshot) and — with legacyPacks:true
// needed to keep the ratchet comparison honest against the real baseline —
// registers all four legacy packs too, not just scheme's own. Re-running
// that on every vault event, including mid-bulk-edit event bursts, would be
// a real cost this pane doesn't need to pay just to stay live; a human
// checking for drift can click Refresh.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { DriftGroup } from "./kernel/drift-view.js";

export const DRIFT_VIEW_TYPE = "vaultmcp-conformance-drift";

export interface DriftPaneController {
  scan(): Promise<DriftGroup[]>;
  openNote(path: string): void;
}

const viewCtl = new WeakMap<DriftPaneView, DriftPaneController>();

export class DriftPaneView extends ItemView {
  private groups: DriftGroup[] = [];
  private error: string | null = null;
  private loading = false;

  constructor(leaf: WorkspaceLeaf, controller: DriftPaneController) {
    super(leaf);
    viewCtl.set(this, controller);
  }

  getViewType(): string { return DRIFT_VIEW_TYPE; }
  getDisplayText(): string { return "JD drift"; }
  getIcon(): string { return "alert-triangle"; }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async onClose(): Promise<void> {}

  private async refresh(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      this.groups = await viewCtl.get(this)!.scan();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("vaultmcp-conformance-drift-pane");

    const total = this.groups.reduce((sum, g) => sum + g.findings.length, 0);
    const header = root.createDiv();
    header.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 6px;";
    header.createEl("h3", { text: "Drift" }).style.margin = "0";
    header.createEl("span", { text: this.loading ? "…" : String(total) }).style.cssText =
      `color: ${total === 0 && !this.loading ? "var(--color-green)" : "var(--text-muted)"}; font-weight: 600;`;

    if (this.error) {
      root.createEl("p", { text: `Scan failed: ${this.error}` }).style.color = "var(--color-red)";
    } else if (!this.loading && this.groups.length === 0) {
      root.createEl("p", { text: "All clear — no new drift." }).style.color = "var(--text-muted)";
    } else if (!this.loading) {
      const controller = viewCtl.get(this)!;
      for (const group of this.groups) {
        const section = root.createEl("details");
        section.setAttr("open", "");
        section.style.marginTop = "8px";
        const summary = section.createEl("summary");
        summary.style.cssText = "cursor: pointer; font-size: var(--font-ui-smaller); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint);";
        summary.setText(`${group.check} (${group.findings.length})`);

        const list = section.createEl("ul");
        list.style.cssText = "list-style: none; margin: 2px 0; padding: 0;";
        for (const finding of group.findings) {
          const li = list.createEl("li");
          li.style.cssText = "padding: 2px 4px; cursor: pointer; border-radius: 4px;";
          li.createEl("div", { text: finding.target }).style.fontWeight = "500";
          li.createEl("div", { text: finding.detail }).style.cssText = "color: var(--text-muted); font-size: var(--font-ui-smaller);";
          li.addEventListener("click", () => controller.openNote(finding.target));
        }
      }
    }

    const footer = root.createDiv();
    footer.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-top: 10px; padding-top: 6px; border-top: 1px solid var(--background-modifier-border);";
    footer.createEl("span", { text: this.loading ? "Scanning…" : `Updated ${new Date().toLocaleTimeString()}` }).style.cssText =
      "color: var(--text-faint); font-size: var(--font-ui-smaller);";
    const btn = footer.createEl("button", { text: "Refresh" });
    btn.disabled = this.loading;
    btn.addEventListener("click", () => void this.refresh());
  }
}
