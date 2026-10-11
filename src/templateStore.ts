import { App, normalizePath, TFile, TFolder } from "obsidian";
import { BrewinSettings } from "./settings";
import { parsePlannerTemplate, PlannerTemplate, sortTemplates, templateFileName, TemplateKind } from "./plannerTemplate";

/**
 * The template library, read from notes in `settings.templatesFolder`.
 *
 * Listing is deliberately synchronous: it comes from Obsidian's metadata cache, so a picker can be
 * built while the modal is being drawn. A template's *body* is not in that cache, so it is fetched
 * only at the moment an item is created — which is the one place it is needed.
 */
export class TemplateStore {
  constructor(private app: App, private settings: BrewinSettings) {}

  private inFolder(path: string): boolean {
    const root = this.settings.templatesFolder.replace(/\/+$/, "");
    return root !== "" && (path === `${root}.md` || path.startsWith(`${root}/`));
  }

  /** Every template in the library, ordered as every picker shows them. Bodies are empty here. */
  list(kind?: TemplateKind): PlannerTemplate[] {
    const out: PlannerTemplate[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.inFolder(file.path)) continue;
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
      const parsed = parsePlannerTemplate({ path: file.path, basename: file.basename, frontmatter: fm, body: "" });
      if (parsed && (!kind || parsed.kind === kind)) out.push(parsed);
    }
    return sortTemplates(out);
  }

  byName(name: string, kind?: TemplateKind): PlannerTemplate | null {
    const wanted = name.trim().toLowerCase();
    return this.list(kind).find((t) => t.name.toLowerCase() === wanted) ?? null;
  }

  /**
   * The template's body — the agenda or checklist it ships — with its frontmatter removed.
   *
   * Read at creation time rather than cached, so editing a template takes effect on the next item
   * without a reload.
   */
  async bodyOf(template: PlannerTemplate): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(template.path);
    if (!(file instanceof TFile)) return "";
    const raw = await this.app.vault.cachedRead(file);
    return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  }

  private async ensureFolder(path: string): Promise<void> {
    let sofar = "";
    for (const part of normalizePath(path).split("/")) {
      sofar = sofar ? `${sofar}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(sofar) instanceof TFolder) continue;
      if (this.app.vault.getAbstractFileByPath(sofar)) return; // a file is in the way
      try {
        await this.app.vault.createFolder(sofar);
      } catch {
        /* created concurrently */
      }
    }
  }

  /** Writes a new template note, never overwriting an existing one. Returns its path. */
  async save(name: string, text: string): Promise<string> {
    const folder = this.settings.templatesFolder.replace(/\/+$/, "");
    await this.ensureFolder(folder);
    let path = normalizePath(`${folder}/${templateFileName(name)}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/${templateFileName(name)} ${n++}.md`);
    }
    await this.app.vault.create(path, text);
    return path;
  }
}
