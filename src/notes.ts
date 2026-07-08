import * as Store from "./notesStore.js";
import { runAppleScript } from "./applescript.js";
import { escapeHtml, renderBody, type NoteBodyFormat } from "./markdown.js";

export interface Note {
  id: string;
  name: string;
  body: string;
  folder: string;
  creationDate: string;
  modificationDate: string;
  attachments: string[];
}

export interface NoteFolder {
  id: string;
  name: string;
  noteCount: number;
}

// ─── AppleScript write helpers ────────────────────────────────────────────────

function isNoteId(identifier: string): boolean {
  return identifier.startsWith("x-coredata://");
}

// Resolve a note identifier (name or x-coredata:// URI) to an AppleScript
// selector expression that reads the identifier from argv[argIndex] — the
// identifier itself is never spliced into the script text.
function asFindClause(identifier: string, argIndex: number): string {
  return isNoteId(identifier)
    ? `note id (item ${argIndex} of argv)`
    : `first note whose name is (item ${argIndex} of argv)`;
}

// ─── HTML → plain text (AppleScript body fallback) ───────────────────────────

function decodeHtmlEntities(s: string): string {
  return s.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);?/g, (_m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X"))
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#"))
      return String.fromCodePoint(parseInt(body.slice(1), 10));
    const t: Record<string, string> = {
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
      ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", auml: "ä", Auml: "Ä",
      euml: "ë", Euml: "Ë", iuml: "ï", Iuml: "Ï",
      aacute: "á", Aacute: "Á", eacute: "é", Eacute: "É",
      iacute: "í", Iacute: "Í", oacute: "ó", Oacute: "Ó", uacute: "ú", Uacute: "Ú",
      agrave: "à", Agrave: "À", egrave: "è", Egrave: "È",
      igrave: "ì", Igrave: "Ì", ograve: "ò", Ograve: "Ò", ugrave: "ù", Ugrave: "Ù",
      atilde: "ã", Atilde: "Ã", otilde: "õ", Otilde: "Õ", ntilde: "ñ", Ntilde: "Ñ",
      acirc: "â", Acirc: "Â", ecirc: "ê", Ecirc: "Ê",
      icirc: "î", Icirc: "Î", ocirc: "ô", Ocirc: "Ô", ucirc: "û", Ucirc: "Û",
      ccedil: "ç", Ccedil: "Ç", szlig: "ß",
      euro: "€", pound: "£", yen: "¥", cent: "¢",
      copy: "©", reg: "®", trade: "™",
      mdash: "—", ndash: "–", hellip: "…", bull: "•",
      laquo: "«", raquo: "»",
      ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
    };
    return t[body] ?? _m;
  });
}

function htmlToPlainText(html: string): string {
  const listStack: string[] = [];
  const parts: string[] = [];
  let atLineStart = true;

  function emit(s: string): void {
    if (!s) return;
    parts.push(s);
    atLineStart = s.endsWith("\n");
  }
  function ensureNewline(): void {
    if (!atLineStart) emit("\n");
  }

  const tagRe = /<([^>]*)>/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > lastIndex) {
      const text = decodeHtmlEntities(html.slice(lastIndex, m.index));
      if (text.trim()) emit(text); // skip whitespace-only inter-tag nodes
    }
    lastIndex = tagRe.lastIndex;

    const raw = m[1].trim();
    const lower = raw.toLowerCase();

    if (lower === "br" || lower.startsWith("br ") || lower === "br/") {
      emit("\n");
      continue;
    }

    const closing = lower.startsWith("/");
    const name = (closing ? lower.slice(1) : lower).split(/[\s/]/)[0];

    switch (name) {
      case "div": case "p":
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        if (closing) ensureNewline();
        break;
      case "ul":
        if (!closing) {
          listStack.push(
            raw.includes("Apple-checklist") ? "checklist" :
            raw.includes("Apple-dash-list") ? "dash" : "plain"
          );
        } else {
          listStack.pop();
          ensureNewline();
        }
        break;
      case "li":
        if (!closing) {
          ensureNewline();
          const indent = "  ".repeat(Math.max(0, listStack.length - 1));
          emit(indent + "- ");
        }
        break;
      // b, i, u, s, a, span, label, input → stripped; text kept
    }
  }

  if (lastIndex < html.length) {
    const text = decodeHtmlEntities(html.slice(lastIndex));
    if (text.trim()) emit(text);
  }

  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

async function fetchBodyViaAppleScript(noteId: string): Promise<string | null> {
  try {
    const result = await runAppleScript(
      `on run argv
tell application "Notes" to return body of note id (item 1 of argv)
end run`,
      [noteId],
      10_000
    );
    return result || null;
  } catch {
    return null;
  }
}

// ─── Read operations — SQLite backed ─────────────────────────────────────────

export async function listFolders(): Promise<NoteFolder[]> {
  return Store.readFolders();
}

type NoteRowOut = Omit<Note, "body" | "attachments">;

export async function listNotes(folderName?: string): Promise<{ results: NoteRowOut[] }> {
  const all = Store.readAllNotes(false);
  const filtered = folderName ? all.filter((n) => n.folder === folderName) : all;
  return { results: filtered };
}

export async function getNote(identifier: string): Promise<Note | null> {
  let found: (Store.NoteRow & { body: string }) | null = null;

  // Try by x-coredata URI: extract Z_PK from "...ICNote/p<num>"
  if (identifier.includes("ICNote/p")) {
    const match = identifier.match(/ICNote\/p(\d+)/);
    if (match) found = Store.readNoteById(parseInt(match[1], 10));
  }

  // Try by title
  if (!found) found = Store.readNoteByTitle(identifier);

  if (found) {
    // SQLite has metadata; body from deterministic protobuf decode.
    // Empty body means the blob was unrecognized — try AppleScript as fallback.
    let body = found.body;
    if (!body) {
      const html = await fetchBodyViaAppleScript(found.id);
      if (html) body = htmlToPlainText(html);
    }
    return {
      id: found.id,
      name: found.name,
      body,
      folder: found.folder,
      creationDate: found.creationDate,
      modificationDate: found.modificationDate,
      attachments: [],
    };
  }

  // Fall back to AppleScript for identifiers SQLite can't resolve
  try {
    const result = await runAppleScript(`on run argv
tell application "Notes"
  set n to missing value
  try
    set n to first note whose name is (item 1 of argv)
  end try
  if n is missing value then try
    set n to note id (item 1 of argv)
  end try
  if n is missing value then return ""
  set attNames to ""
  repeat with att in attachments of n
    set attNames to attNames & (name of att) & ";;;"
  end repeat
  set fName to "(unknown folder)"
  try
    set fName to name of container of n
  end try
  return (id of n) & "|||" & (name of n) & "|||" & (body of n) & "|||" & fName & "|||" & ((creation date of n) as string) & "|||" & ((modification date of n) as string) & "|||" & attNames
end tell
end run`, [identifier]);
    if (!result.trim()) return null;
    const p = result.split("|||");
    return {
      id: p[0]?.trim() ?? "",
      name: p[1]?.trim() ?? "",
      body: htmlToPlainText(p[2]?.trim() ?? ""),
      folder: p[3]?.trim() ?? "",
      creationDate: p[4]?.trim() ?? "",
      modificationDate: p[5]?.trim() ?? "",
      attachments: (p[6] ?? "").split(";;;").filter((a) => a.trim()).map((a) => a.trim()),
    };
  } catch {
    return null;
  }
}

export async function getFolderWithBodies(
  folder?: string,
  maxCharsPerBody?: number
): Promise<Array<Store.NoteRow & { body: string; truncated: boolean }>> {
  return Store.readFolderWithBodies(folder, maxCharsPerBody);
}

export async function searchNotes(
  query: string,
  withBody = false,
  maxChars?: number
): Promise<{ results: (NoteRowOut | (NoteRowOut & { body: string; truncated: boolean }))[] }> {
  const q = query.toLowerCase();
  const all = Store.readAllNotesWithBody(); // one DB open for the whole search
  const filtered = all.filter((n) => `${n.name} ${n.body}`.toLowerCase().includes(q));
  if (withBody) {
    const limit = maxChars ?? 300;
    const results = filtered.map(({ body, ...row }) => {
      let b = body;
      let truncated = false;
      if (b.length > limit) { b = b.slice(0, limit); truncated = true; }
      return { ...row, body: b, truncated };
    });
    return { results };
  }
  const results = filtered.map(({ body: _body, ...row }) => row);
  return { results };
}

export interface NoteFilter {
  folder?: string;
  search?: string;
}

function matchNotes(filter: NoteFilter): Store.NoteRow[] {
  const q = (filter.search ?? "").toLowerCase();
  const needsBody = q.length > 0;

  if (needsBody) {
    const all = Store.readAllNotesWithBody();
    return all.filter((n) => {
      if (filter.folder && n.folder !== filter.folder) return false;
      if (q && !`${n.name} ${n.body}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  const all = Store.readAllNotes(false);
  return all.filter((n) => {
    if (filter.folder && n.folder !== filter.folder) return false;
    return true;
  });
}

export async function countNotesWhere(filter: NoteFilter): Promise<{ count: number }> {
  return { count: matchNotes(filter).length };
}

export async function queryNotesWhere(
  filter: NoteFilter,
  countOnly: boolean
): Promise<{ count: number } | { results: NoteRowOut[] }> {
  const matches = matchNotes(filter);
  if (countOnly) return { count: matches.length };
  return { results: matches };
}

// ─── Write operations — AppleScript ──────────────────────────────────────────

export async function createNote(
  name: string,
  body: string,
  folderName?: string,
  format: NoteBodyFormat = "markdown"
): Promise<string> {
  // Notes.app derives a new note's displayed title from the first line of its body
  // at creation time — prepending the title as its own heading keeps it in sync
  // with the `name` property regardless of what the body otherwise renders as.
  const finalBody = `<h1>${escapeHtml(name)}</h1>` + renderBody(body, format);
  const args = [name, finalBody];
  let folderClause = "";
  if (folderName) {
    args.push(folderName);
    folderClause = `at folder (item 3 of argv) `;
  }
  return runAppleScript(
    `on run argv
tell application "Notes"
  set n to make new note ${folderClause}with properties {name:(item 1 of argv), body:(item 2 of argv)}
  return id of n
end tell
end run`,
    args
  );
}

async function noteAttachmentCount(identifier: string): Promise<number> {
  const result = await runAppleScript(
    `on run argv
tell application "Notes"
  set n to ${asFindClause(identifier, 1)}
  return (count of attachments of n) as string
end tell
end run`,
    [identifier]
  );
  return parseInt(result.trim() || "0", 10);
}

// Raw HTML as Notes.app itself renders it (including any attachment markup) — distinct
// from Notes.get()'s decoded plain text, which discards formatting and attachments entirely.
async function fetchRawBodyByIdentifier(identifier: string): Promise<string> {
  return runAppleScript(
    `on run argv
tell application "Notes"
  set n to ${asFindClause(identifier, 1)}
  return body of n
end tell
end run`,
    [identifier]
  );
}

export interface UpdateNoteOptions {
  name?: string;
  body?: string;
  folderName?: string;
  format?: NoteBodyFormat;
  mode?: "replace" | "append" | "prepend";
  force?: boolean;
}

export type UpdateNoteResult = { applied: true } | { applied: false; warning: string };

export async function updateNote(identifier: string, updates: UpdateNoteOptions): Promise<UpdateNoteResult> {
  let finalBody: string | undefined;

  if (updates.body !== undefined) {
    const format = updates.format ?? "markdown";
    const mode = updates.mode ?? "replace";
    const newHtml = renderBody(updates.body, format);

    if (mode === "replace") {
      // A full body replace can't preserve attachments — we never re-embed the original
      // attachment markup here — so require an explicit opt-in once any exist.
      const attachmentCount = await noteAttachmentCount(identifier);
      if (attachmentCount > 0 && !updates.force) {
        return {
          applied: false,
          warning:
            `This note has ${attachmentCount} attachment(s) that a full body replace would destroy. ` +
            `Re-call with force=true to replace anyway, or use mode="append"/"prepend" to keep them.`,
        };
      }
      const title = updates.name ?? (await getNote(identifier))?.name ?? "";
      finalBody = `<h1>${escapeHtml(title)}</h1>` + newHtml;
    } else {
      // append/prepend keep the note's existing raw HTML (attachments included) and
      // just add the newly rendered content alongside it.
      const currentRawBody = await fetchRawBodyByIdentifier(identifier);
      finalBody =
        mode === "append"
          ? currentRawBody + "<div><br></div>" + newHtml
          : newHtml + "<div><br></div>" + currentRawBody;
    }
  }

  const args = [identifier];
  let script = `on run argv\ntell application "Notes"\n  set n to ${asFindClause(identifier, 1)}\n`;
  if (updates.name !== undefined) {
    args.push(updates.name);
    script += `  set name of n to (item ${args.length} of argv)\n`;
  }
  if (finalBody !== undefined) {
    args.push(finalBody);
    script += `  set body of n to (item ${args.length} of argv)\n`;
  }
  if (updates.folderName !== undefined) {
    args.push(updates.folderName);
    script += `  move n to folder (item ${args.length} of argv)\n`;
  }
  script += `end tell\nend run`;
  await runAppleScript(script, args);
  return { applied: true };
}

export async function deleteNote(identifier: string): Promise<void> {
  await runAppleScript(
    `on run argv\ntell application "Notes"\ndelete ${asFindClause(identifier, 1)}\nend tell\nend run`,
    [identifier]
  );
}

export async function createFolder(name: string): Promise<string> {
  return runAppleScript(
    `on run argv\ntell application "Notes"\nset f to make new folder with properties {name:(item 1 of argv)}\nreturn id of f\nend tell\nend run`,
    [name]
  );
}

export async function moveNote(identifier: string, folderName: string): Promise<void> {
  await runAppleScript(
    `on run argv\ntell application "Notes"\nmove ${asFindClause(identifier, 1)} to folder (item 2 of argv)\nend tell\nend run`,
    [identifier, folderName]
  );
}

// ─── Filter-based bulk operations ─────────────────────────────────────────────

async function actOnIds(ids: string[], action: "delete" | { moveTo: string }): Promise<number> {
  if (ids.length === 0) return 0;
  const isMove = action !== "delete";
  const args = isMove ? [...ids, (action as { moveTo: string }).moveTo] : ids;
  // `argv` is already an AppleScript list here; when moving, the last item is
  // the destination folder, so only the leading `ids.length` items are targets.
  const idsExpr = isMove ? `items 1 thru ${ids.length} of argv` : "argv";
  const verb = isMove ? `move note id theId to folder (item ${ids.length + 1} of argv)` : "delete note id theId";
  const raw = await runAppleScript(
    `on run argv
tell application "Notes"
  with timeout of 600 seconds
    set cnt to 0
    repeat with theId in (${idsExpr})
      try
        ${verb}
        set cnt to cnt + 1
      end try
    end repeat
    return cnt as string
  end timeout
end tell
end run`,
    args,
    620_000
  );
  return parseInt(raw.trim() || "0", 10);
}

export async function deleteNotesWhere(
  filter: NoteFilter,
  confirm: boolean
): Promise<{ count: number; confirmed: false } | { deleted: number; confirmed: true }> {
  const matches = matchNotes(filter);
  if (!confirm) return { count: matches.length, confirmed: false };
  const deleted = await actOnIds(matches.map((m) => m.id), "delete");
  return { deleted, confirmed: true };
}

export async function moveNotesWhere(
  filter: NoteFilter,
  destinationFolder: string,
  confirm: boolean
): Promise<{ count: number; confirmed: false } | { moved: number; confirmed: true }> {
  const matches = matchNotes(filter);
  if (!confirm) return { count: matches.length, confirmed: false };
  const moved = await actOnIds(matches.map((m) => m.id), { moveTo: destinationFolder });
  return { moved, confirmed: true };
}
