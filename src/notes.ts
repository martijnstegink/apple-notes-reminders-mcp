import * as Store from "./notesStore.js";
import { runAppleScript } from "./applescript.js";
import { escapeHtml, renderBody, type NoteBodyFormat } from "./markdown.js";

// Research spike: adding images to a note via the `shortcuts` CLI bridge.
// Not implemented — confirmed not viable as a zero-setup MCP tool:
//   - `shortcuts run <name> -i <path>` takes exactly one input (a file) and one
//     output path; there's no flag to also pass a target note name/id alongside
//     the image, so a workflow would have to smuggle it in some other way (e.g.
//     encoding the note identifier into the input file's name for the shortcut
//     to parse back out — fragile, and still requires the shortcut to contain a
//     "Find Notes" + "Add to Note" action pair).
//   - The `shortcuts` CLI can only run/list/view/sign shortcuts that already
//     exist (confirmed via `shortcuts --help`) — there's no `create` subcommand.
//     Authoring one programmatically means hand-building Apple's WFWorkflow
//     plist format for Notes-specific actions, which isn't documented and would
//     be its own multi-day reverse-engineering effort.
//   - Even if built, invoking it would depend on a *user-authored* Shortcut
//     existing on their machine ahead of time — not something this server can
//     set up on its own, so it wouldn't actually be a zero-setup capability.
// Conclusion: not worth the fragility for what it would unlock. Attachments
// remain read-only from this server's side (see readAttachments/getAttachment
// below); adding one still requires the Notes.app UI.

export interface Note {
  id: string;
  name: string;
  body: string;
  folder: string;
  creationDate: string;
  modificationDate: string;
  attachments: Store.AttachmentInfo[];
}

function zpkFromNoteId(id: string): number | null {
  const match = id.match(/ICNote\/p(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export interface NoteFolder {
  id: string;
  name: string;
  path: string;
  account: string;
  isSmartFolder: boolean;
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

// Resolves a "/"-separated folder path (from argv[argIndex]) into `varName`,
// walking one path segment at a time. Two AppleScript quirks forced this shape
// (confirmed live against Notes.app): (1) top-level lookups are reliable via
// `first folder whose name is X`, but that same `whose` filter — and
// `folder id "..."` — become unreliable (intermittent "item N of every folder
// kan niet worden opgevraagd" errors, sometimes on folders that plainly
// exist) once a nested sub-folder is involved; a hand-rolled `repeat...every
// folder of <parent>` scan is what reliably finds those instead. (2) the
// top-level `folder`/`every folder` collection only contains top-level
// folders — nested ones only appear via `every folder of <parent>` — so the
// manual scan is required for segIdx > 1 regardless.
function folderResolveScript(argIndex: number, varName: string): string {
  return `
  set savedTID to AppleScript's text item delimiters
  set AppleScript's text item delimiters to "/"
  set pathParts to text items of (item ${argIndex} of argv)
  set AppleScript's text item delimiters to savedTID
  set ${varName} to missing value
  repeat with segIdx from 1 to (count of pathParts)
    set seg to item segIdx of pathParts
    set found to missing value
    if segIdx = 1 then
      try
        set found to first folder whose name is seg
      end try
    else
      repeat with candidate in (every folder of ${varName})
        if name of candidate is seg then
          set found to candidate
          exit repeat
        end if
      end repeat
    end if
    if found is missing value then error "Folder not found: " & (item ${argIndex} of argv)
    set ${varName} to found
  end repeat
`;
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
    const zpk = zpkFromNoteId(found.id);
    return {
      id: found.id,
      name: found.name,
      body,
      folder: found.folder,
      creationDate: found.creationDate,
      modificationDate: found.modificationDate,
      attachments: zpk != null ? Store.readAttachments(zpk) : [],
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
      // AppleScript's `attachments of n` only exposes a name — no id/typeUTI/OCR,
      // unlike the Store.readAttachments() path used above for SQLite-resolved notes.
      attachments: (p[6] ?? "")
        .split(";;;")
        .filter((a) => a.trim())
        .map((a) => ({ id: "", filename: a.trim(), typeUTI: "", filePath: null, ocrText: null })),
    };
  } catch {
    return null;
  }
}

export async function getAttachment(id: string): Promise<Store.AttachmentInfo | null> {
  return Store.readAttachmentByIdentifier(id);
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
  const ocrByNote = Store.readOcrTextByNote(); // fold recognized text from image attachments into the search corpus
  const filtered = all.filter((n) => {
    const zpk = zpkFromNoteId(n.id);
    const ocr = zpk != null ? (ocrByNote.get(zpk) ?? "") : "";
    return `${n.name} ${n.body} ${ocr}`.toLowerCase().includes(q);
  });
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

// Notes stores hashtags as literal "#word" text in the note body (Notes.app
// auto-links them on its own — see markdown.ts) rather than as a queryable
// DB relationship, so tags are derived by scanning decoded bodies.
const TAG_RE = /#([\p{L}\p{N}_]+)/gu;

function extractTags(body: string): Set<string> {
  const tags = new Set<string>();
  for (const m of body.matchAll(TAG_RE)) tags.add(m[1].toLowerCase());
  return tags;
}

export interface NoteFilter {
  folder?: string;
  search?: string;
  tag?: string;
}

function matchNotes(filter: NoteFilter): Store.NoteRow[] {
  const q = (filter.search ?? "").toLowerCase();
  const tag = filter.tag?.replace(/^#/, "").toLowerCase();
  const needsBody = q.length > 0 || !!tag;

  if (needsBody) {
    const all = Store.readAllNotesWithBody();
    const ocrByNote = q ? Store.readOcrTextByNote() : null;
    return all.filter((n) => {
      if (filter.folder && n.folder !== filter.folder) return false;
      if (q) {
        const zpk = zpkFromNoteId(n.id);
        const ocr = (zpk != null && ocrByNote) ? (ocrByNote.get(zpk) ?? "") : "";
        if (!`${n.name} ${n.body} ${ocr}`.toLowerCase().includes(q)) return false;
      }
      if (tag && !extractTags(n.body).has(tag)) return false;
      return true;
    });
  }

  const all = Store.readAllNotes(false);
  return all.filter((n) => {
    if (filter.folder && n.folder !== filter.folder) return false;
    return true;
  });
}

export async function listTags(): Promise<{ tag: string; noteCount: number }[]> {
  const all = Store.readAllNotesWithBody();
  const counts = new Map<string, number>();
  for (const n of all) {
    for (const tag of extractTags(n.body)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, noteCount]) => ({ tag, noteCount }))
    .sort((a, b) => b.noteCount - a.noteCount || a.tag.localeCompare(b.tag));
}

export async function listRecentlyDeleted(): Promise<NoteRowOut[]> {
  return Store.readRecentlyDeleted().map(({ body: _body, ...row }) => row);
}

export async function restoreNote(identifier: string, destinationFolder = "Notes"): Promise<void> {
  await moveNote(identifier, destinationFolder);
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
  // Notes.app itself inserts `name` as the body's literal first line when both
  // `name:` and `body:` are given to `make new note` — prepending our own title
  // here would duplicate it, not keep it in sync.
  const finalBody = renderBody(body, format);
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

    // Setting `body` — in any mode — re-renders the note's HTML, and re-submitting
    // captured attachment markup (e.g. an <img data:...> src) through the `body`
    // setter does not actually re-attach it: the attachment becomes orphaned even
    // though it still counts toward `attachments of n`. So no mode can safely touch
    // body once attachments exist without an explicit opt-in.
    const attachmentCount = await noteAttachmentCount(identifier);
    if (attachmentCount > 0 && !updates.force) {
      return {
        applied: false,
        warning:
          `This note has ${attachmentCount} attachment(s). Setting the body in any mode ` +
          `(replace/append/prepend) does not reliably preserve them — they may become orphaned. ` +
          `Re-call with force=true to proceed anyway.`,
      };
    }

    if (mode === "replace") {
      // Existing note: setting `body of n` alone re-derives the displayed title from
      // the new body's first line, so preserve the current title as an explicit heading.
      const title = updates.name ?? (await getNote(identifier))?.name ?? "";
      finalBody = `<h1>${escapeHtml(title)}</h1>` + newHtml;
    } else {
      // append/prepend keep the note's existing raw HTML and add the newly rendered
      // content alongside it — fine for preserving non-attachment formatting, but
      // (per the guard above) not attachments themselves.
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

export async function renameFolder(identifier: string, newName: string): Promise<void> {
  await runAppleScript(
    `on run argv
tell application "Notes"
${folderResolveScript(1, "f")}
  set name of f to (item 2 of argv)
end tell
end run`,
    [identifier, newName]
  );
}

// Deletes the folder and moves its notes to Recently Deleted (Notes.app's own
// behavior for folder deletion — not a permanent, unrecoverable delete).
export async function deleteFolder(identifier: string): Promise<void> {
  await runAppleScript(
    `on run argv
tell application "Notes"
${folderResolveScript(1, "f")}
  delete f
end tell
end run`,
    [identifier]
  );
}

// No moveFolder (re-parenting): confirmed live that Notes.app's AppleScript
// `move <folder> to <folder>` is unreliable — it sometimes throws
// "item N of every folder kan niet worden opgevraagd" and sometimes silently
// no-ops, whether the folder reference comes from `folder id`, a `whose`
// filter, or a hand-rolled `repeat...every folder` scan (all three were
// tried). Renaming and deleting a folder are reliable (tested above);
// shipping a re-parent tool that fails unpredictably would be worse than not
// having one, so it's intentionally not implemented.

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
