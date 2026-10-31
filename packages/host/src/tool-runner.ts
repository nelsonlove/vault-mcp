// tool-runner.ts — the in-Obsidian dev tool-runner's modal chain (the
// un-headless half; the listing/schema/parsing/invocation logic lives in
// tool-runner-core.ts and is unit-tested there).
//
// ONE command ("Vault MCP: Run tool…", main.ts) opens a fuzzy picker over the
// tools available on the CURRENT surface, then an args form derived from the
// picked tool's zod schema, then a result modal. Invocation goes through
// runCapturedTool → callCapturedTool — the exact path a code-mode MCP
// connection's obsidian_call_tool takes — so the guard wrapper (read-only
// mode, path allowlist, uid addressing, the retired-scheme-ref refusal, kernel queue/journal,
// accept-forbidden in the write primitives) binds identically. The runner adds
// NO capability beyond what the MCP surface already exposes; it is the same
// surface, human-triggered.

import { App, FuzzySuggestModal, Modal, Notice, Setting, type FuzzyMatch } from "obsidian";
import type { CapturedRegistry } from "./mcp/tools-code-mode.js";
import {
  buildRunArgs,
  errorLineOf,
  formFieldsOf,
  listRunnerTools,
  needsConfirm,
  renderResultText,
  runCapturedTool,
  runsImmediately,
  type RunnerField,
  type RunnerRun,
  type RunnerToolSummary,
} from "./tool-runner-core.js";
import { ensureSettingsStyles } from "./settings-styles.js";

/**
 * Entry point, called by the "Run tool…" command. `buildRegistry` is invoked
 * LAZILY here — a fresh capture per invocation, exactly like a new MCP
 * connection — so conditional tools (Dataview/Templater/CLI/module tools)
 * always reflect the live state, and a settings change lands on the next run.
 */
export function openToolRunner(app: App, buildRegistry: () => CapturedRegistry): void {
  ensureSettingsStyles();
  let registry: CapturedRegistry;
  try {
    registry = buildRegistry();
  } catch (e) {
    new Notice(`vault-mcp: tool-runner failed to build the tool registry — ${(e as Error).message}`);
    return;
  }
  new ToolPickerModal(app, registry).open();
}

async function execute(
  app: App,
  registry: CapturedRegistry,
  summary: RunnerToolSummary,
  args: Record<string, unknown>
): Promise<void> {
  const run = await runCapturedTool(registry, summary.name, args);
  new ToolResultModal(app, run).open();
}

// ── step 1: fuzzy tool picker ────────────────────────────────────────────────

class ToolPickerModal extends FuzzySuggestModal<RunnerToolSummary> {
  constructor(app: App, private readonly registry: CapturedRegistry) {
    super(app);
    this.setPlaceholder("Run a Vault MCP tool…");
  }

  getItems(): RunnerToolSummary[] {
    return listRunnerTools(this.registry);
  }

  // Matched against name, title AND description, so "backlinks" finds the tool
  // whatever the exact name is — same haystack the code-mode search uses.
  getItemText(t: RunnerToolSummary): string {
    return `${t.name} ${t.title} ${t.description}`;
  }

  renderSuggestion(match: FuzzyMatch<RunnerToolSummary>, el: HTMLElement): void {
    const t = match.item;
    el.addClass("vault-mcp-runner-item");
    const head = el.createDiv({ cls: "vault-mcp-runner-item-head" });
    head.createSpan({ cls: "vault-mcp-runner-item-name", text: t.name });
    head.createSpan({
      cls: `vault-mcp-runner-badge ${t.mutating ? "vault-mcp-runner-badge--write" : "vault-mcp-runner-badge--read"}`,
      text: t.mutating ? "writes" : "read-only",
    });
    if (t.title && t.title !== t.name) head.createSpan({ cls: "vault-mcp-runner-item-title", text: t.title });
    if (t.description) el.createDiv({ cls: "vault-mcp-runner-item-desc", text: t.description });
  }

  onChooseItem(t: RunnerToolSummary): void {
    const fields = formFieldsOf(this.registry.get(t.name)?.def.inputSchema);
    if (runsImmediately(fields, t)) {
      // Nothing to collect and nothing to confirm — run now.
      void execute(this.app, this.registry, t, {});
      return;
    }
    new ToolArgsModal(this.app, this.registry, t, fields).open();
  }
}

// ── step 2: args form (+ write confirm) ──────────────────────────────────────

class ToolArgsModal extends Modal {
  private readonly values: Record<string, string> = {};
  private confirmed = false;
  private errorsEl!: HTMLElement;

  constructor(
    app: App,
    private readonly registry: CapturedRegistry,
    private readonly summary: RunnerToolSummary,
    private readonly fields: RunnerField[]
  ) {
    super(app);
  }

  onOpen(): void {
    ensureSettingsStyles();
    this.modalEl.addClass("vault-mcp-runner-modal");
    this.titleEl.setText(`Run ${this.summary.name}`);
    const { contentEl } = this;
    if (this.summary.description) {
      contentEl.createEl("p", { cls: "vault-mcp-runner-desc", text: this.summary.description });
    }

    for (const field of this.fields) this.renderField(contentEl, field);

    this.errorsEl = contentEl.createDiv({ cls: "vault-mcp-runner-errors" });

    let runBtn: import("obsidian").ButtonComponent | undefined;
    const mutating = needsConfirm(this.summary);
    if (mutating) {
      contentEl.createDiv({
        cls: "vault-mcp-runner-warning",
        text: "This tool writes to the vault. The run goes through the same guard, queue and journal as an agent call.",
      });
      new Setting(contentEl)
        .setName("This tool writes — run it?")
        .setDesc("Required for mutating tools.")
        .addToggle((t) =>
          t.setValue(false).onChange((v) => {
            this.confirmed = v;
            runBtn?.setDisabled(!v);
          })
        );
    }

    new Setting(contentEl).addButton((b) => {
      runBtn = b;
      b.setButtonText(mutating ? "Run (writes)" : "Run").setCta();
      if (mutating) b.setDisabled(true);
      b.onClick(() => void this.run());
    });
  }

  private renderField(containerEl: HTMLElement, field: RunnerField): void {
    const setting = new Setting(containerEl)
      .setName(field.optional ? `${field.name} (optional)` : field.name)
      .setDesc(field.description ?? "");
    switch (field.kind) {
      case "boolean":
        if (field.optional) {
          setting.addDropdown((d) =>
            d
              .addOptions({ "": "(omit)", true: "true", false: "false" })
              .setValue("")
              .onChange((v) => (this.values[field.name] = v))
          );
        } else {
          this.values[field.name] = "false";
          setting.addToggle((t) =>
            t.setValue(false).onChange((v) => (this.values[field.name] = v ? "true" : "false"))
          );
        }
        break;
      case "json":
        setting.addTextArea((ta) => {
          ta.setPlaceholder(field.optional ? "JSON (blank = omit)" : "JSON");
          ta.inputEl.rows = 4;
          ta.inputEl.addClass("vault-mcp-runner-json");
          ta.onChange((v) => (this.values[field.name] = v));
        });
        break;
      default:
        setting.addText((t) => {
          t.setPlaceholder(field.kind === "number" ? "number" : "");
          t.onChange((v) => (this.values[field.name] = v));
        });
    }
  }

  private async run(): Promise<void> {
    if (needsConfirm(this.summary) && !this.confirmed) return; // belt-and-suspenders; the button is disabled
    const built = buildRunArgs(this.fields, this.values);
    if ("errors" in built) {
      this.errorsEl.empty();
      for (const err of built.errors) this.errorsEl.createDiv({ cls: "vault-mcp-runner-error-line", text: err });
      return;
    }
    this.close();
    await execute(this.app, this.registry, this.summary, built.args);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── step 3: result modal ─────────────────────────────────────────────────────

class ToolResultModal extends Modal {
  constructor(app: App, private readonly run: RunnerRun) {
    super(app);
  }

  onOpen(): void {
    ensureSettingsStyles();
    this.modalEl.addClass("vault-mcp-runner-modal");
    this.titleEl.setText(this.run.tool);
    const { contentEl } = this;

    const errorLine = errorLineOf(this.run.result);
    if (errorLine !== null) {
      contentEl.createDiv({ cls: "vault-mcp-runner-error-banner", text: errorLine });
    }

    contentEl.createDiv({ cls: "vault-mcp-runner-meta", text: `${this.run.elapsedMs} ms` });

    contentEl.createDiv({ cls: "vault-mcp-runner-section", text: "Args" });
    contentEl.createEl("pre", { cls: "vault-mcp-runner-pre", text: JSON.stringify(this.run.args, null, 2) });

    const resultText = renderResultText(this.run.result);
    contentEl.createDiv({ cls: "vault-mcp-runner-section", text: errorLine !== null ? "Error detail" : "Result" });
    contentEl.createEl("pre", { cls: "vault-mcp-runner-pre vault-mcp-runner-pre--result", text: resultText });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Copy result").onClick(async () => {
        await navigator.clipboard.writeText(resultText);
        new Notice("vault-mcp: result copied.");
      })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
