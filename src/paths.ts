// Folder settings, spelt the way Obsidian spells paths. The Planner finds its notes by comparing
// paths as text, so a folder typed with a trailing slash, with Windows backslashes, or with capitals
// that differ from the folder on disk (macOS and Windows don't mind; Obsidian's paths, phones and
// Linux do) matched nothing — and the Planner showed no tasks at all. Pure, no Obsidian imports.

/**
 * A typed folder path as a vault path: forward slashes, none doubled or at either end, Obsidian's
 * non-breaking-space rule, and Unicode NFC — macOS can hand over decomposed accents, which then
 * never equal the composed ones in the vault's own paths.
 */
export function cleanFolder(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[\u00a0\u202f]/g, " ")
    .normalize("NFC");
}

/** The folder as the vault spells it, when the typed path differs from one only in capitals. */
export function matchFolderCase(path: string, folders: Iterable<string>): string {
  if (!path) return path;
  const lower = path.toLowerCase();
  let found: string | null = null;
  for (const f of folders) {
    if (f === path) return path;
    if (found === null && f.toLowerCase() === lower) found = f;
  }
  return found ?? path;
}
