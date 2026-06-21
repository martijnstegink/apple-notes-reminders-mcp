import { execFileSync } from "child_process";
import * as Store from "./notesStore.js";

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

function runAS(script: string): string {
  return execFileSync("osascript", ["-e", script], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

// Resolve a note identifier (name or x-coredata:// URI) to AppleScript selector
function asFind(identifier: string): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  return identifier.includes(":") ? `note id "${esc(identifier)}"` : `first note whose name is "${esc(identifier)}"`;
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

function fetchBodyViaAppleScript(noteId: string): string | null {
  try {
    const esc = (s: string) => s.replace(/"/g, '\\"');
    return execFileSync(
      "osascript",
      ["-e", `tell application "Notes" to return body of note id "${esc(noteId)}"`],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }
    ).trim() || null;
  } catch {
    return null;
  }
}

// ─── Read operations — SQLite backed ─────────────────────────────────────────

export async function listFolders(): Promise<NoteFolder[]> {
  return Store.readFolders();
}

type NoteRowOut = Omit<Note, "body" | "attachments">;

export async function listNotes(
  folderName?: string
): Promise<{ results: NoteRowOut[]; skipped: number }> {
  const all = Store.readAllNotes(false);
  const filtered = folderName ? all.filter((n) => n.folder === folderName) : all;
  return { results: filtered, skipped: 0 };
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
      const html = fetchBodyViaAppleScript(found.id);
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
    const esc = (s: string) => s.replace(/"/g, '\\"');
    const result = runAS(`tell application "Notes"
  set n to missing value
  try
    set n to first note whose name is "${esc(identifier)}"
  end try
  if n is missing value then try
    set n to note id "${esc(identifier)}"
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
end tell`);
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
  query: string
): Promise<{ results: NoteRowOut[]; skipped: number }> {
  const q = query.toLowerCase();
  const all = Store.readAllNotesWithBody();
  const results = all
    .filter((n) => `${n.name} ${n.body}`.toLowerCase().includes(q))
    .map(({ body: _body, ...row }) => row);
  return { results, skipped: 0 };
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

export async function countNotesWhere(
  filter: NoteFilter
): Promise<{ count: number; skipped: number }> {
  return { count: matchNotes(filter).length, skipped: 0 };
}

export async function queryNotesWhere(
  filter: NoteFilter,
  countOnly: boolean
): Promise<{ count: number; skipped: number } | { results: NoteRowOut[]; skipped: number }> {
  const matches = matchNotes(filter);
  if (countOnly) return { count: matches.length, skipped: 0 };
  return { results: matches, skipped: 0 };
}

// ─── Write operations — AppleScript ──────────────────────────────────────────

export async function createNote(name: string, body: string, folderName?: string): Promise<string> {
  const esc = (s: string) => s.replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return runAS(`tell application "Notes"
  set n to make new note ${folderName ? `at folder "${folderName.replace(/"/g, '\\"')}"` : ""} with properties {name:"${esc(name)}", body:"${esc(body)}"}
  return id of n
end tell`);
}

export async function updateNote(identifier: string, updates: { name?: string; body?: string; folderName?: string }): Promise<void> {
  const esc = (s: string) => s.replace(/"/g, '\\"').replace(/\n/g, "\\n");
  runAS(`tell application "Notes"
  set n to ${asFind(identifier)}
  ${updates.name ? `set name of n to "${esc(updates.name)}"` : ""}
  ${updates.body !== undefined ? `set body of n to "${esc(updates.body)}"` : ""}
  ${updates.folderName ? `move n to folder "${updates.folderName.replace(/"/g, '\\"')}"` : ""}
end tell`);
}

export async function deleteNote(identifier: string): Promise<void> {
  runAS(`tell application "Notes"\ndelete ${asFind(identifier)}\nend tell`);
}

export async function createFolder(name: string): Promise<string> {
  return runAS(`tell application "Notes"\nset f to make new folder with properties {name:"${name.replace(/"/g, '\\"')}"}\nreturn id of f\nend tell`);
}

export async function moveNote(identifier: string, folderName: string): Promise<void> {
  runAS(`tell application "Notes"\nmove ${asFind(identifier)} to folder "${folderName.replace(/"/g, '\\"')}"\nend tell`);
}

// ─── Filter-based bulk operations ─────────────────────────────────────────────

function actOnIds(ids: string[], action: "delete" | { moveTo: string }): number {
  if (ids.length === 0) return 0;
  const listLiteral = ids.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(", ");
  const verb =
    action === "delete"
      ? "delete note id theId"
      : `move note id theId to folder "${(action as { moveTo: string }).moveTo.replace(/"/g, '\\"')}"`;
  const raw = runAS(`tell application "Notes"
  with timeout of 600 seconds
    set cnt to 0
    repeat with theId in {${listLiteral}}
      try
        ${verb}
        set cnt to cnt + 1
      end try
    end repeat
    return cnt as string
  end timeout
end tell`);
  return parseInt(raw.trim() || "0", 10);
}

export async function deleteNotesWhere(
  filter: NoteFilter,
  confirm: boolean
): Promise<{ count: number; skipped: number; confirmed: false } | { deleted: number; skipped: number; confirmed: true }> {
  const matches = matchNotes(filter);
  if (!confirm) return { count: matches.length, skipped: 0, confirmed: false };
  const deleted = actOnIds(matches.map((m) => m.id), "delete");
  return { deleted, skipped: 0, confirmed: true };
}

export async function moveNotesWhere(
  filter: NoteFilter,
  destinationFolder: string,
  confirm: boolean
): Promise<{ count: number; skipped: number; confirmed: false } | { moved: number; skipped: number; confirmed: true }> {
  const matches = matchNotes(filter);
  if (!confirm) return { count: matches.length, skipped: 0, confirmed: false };
  const moved = actOnIds(matches.map((m) => m.id), { moveTo: destinationFolder });
  return { moved, skipped: 0, confirmed: true };
}
