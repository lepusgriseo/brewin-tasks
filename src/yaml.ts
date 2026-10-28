// The frontmatter of a new task, event or trip note is written out line by line, so free text in it
// — a title, a context, a place — has to be quoted wherever YAML would read it as something else:
// `Call: dentist` is a mapping, `Dinner #2` loses `#2` to a comment, `@home` and `[draft]` start
// other syntax, and `yes` or `12:30` stop being text. Any of those used to make the whole block fail
// to parse, and the note dropped out of the Planner with all its properties. Text is written bare
// when that's safe, so ordinary notes look as they always have. Pure, no Obsidian imports.

/** Characters that mean something at the start of a plain scalar. */
const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

/**
 * Bare, these read as a boolean, null, a number, a date or a merge key in one YAML version or
 * another (Obsidian's parser is YAML 1.2; older tools reading the same notes are 1.1).
 */
const NOT_TEXT =
  /^(?:true|false|yes|no|on|off|y|n|null|~|<<|=|[-+]?\.?\d[\d_.,:]*(?:e[-+]?\d+)?|[-+]?\.(?:inf|nan)|0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+|\d{4}-\d\d?-\d\d?(?:[Tt\s].*)?)$/i;

/**
 * `s` as a YAML scalar: as it is when it reads back unchanged, else double-quoted (JSON's string
 * syntax is valid YAML). `flow` is for items inside `[a, b]`, where `,[]{}` end an item and `?`,
 * `:` and `#` are best quoted too.
 */
export function yamlString(s: string, o: { flow?: boolean } = {}): string {
  if (s === "") return '""';
  const plain =
    !INDICATOR_START.test(s) &&
    !/^\s|\s$/.test(s) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f\u0085\u2028\u2029\ufeff]/.test(s) &&
    !/: |:$| #/.test(s) &&
    !(o.flow && /[,[\]{}?:#]/.test(s)) &&
    !NOT_TEXT.test(s);
  return plain ? s : JSON.stringify(s);
}
