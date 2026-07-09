import Database from "better-sqlite3";
import { gunzipSync, inflateSync } from "zlib";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

const DB_PATH = join(homedir(), "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite");
const CORE_DATA_EPOCH_OFFSET = 978307200; // seconds between Unix epoch and Core Data epoch (2001-01-01)

export interface NoteRow {
  id: string;
  name: string;
  folder: string;
  creationDate: string;
  modificationDate: string;
  pinned: boolean;
}

export interface NoteRecord extends NoteRow {
  body: string;
  attachments: string[];
}

export interface AttachmentInfo {
  id: string; // media identifier when available (else the attachment's own identifier) — pass to readAttachmentByIdentifier
  filename: string;
  typeUTI: string; // e.g. "public.jpeg", "com.apple.notes.table", "com.adobe.pdf"
  filePath: string | null; // absolute path on disk; null if the media file/generation folder couldn't be resolved
  ocrText: string | null; // recognized text from an image attachment; null if none
}

export interface FolderRecord {
  id: string;
  name: string;
  path: string; // full nested path, e.g. "Recipes/Desserts" — just `name` for top-level folders
  account: string; // e.g. "iCloud" or "On My Mac"; "" if undetectable
  isSmartFolder: boolean; // true for Apple-managed special folders (e.g. Recently Deleted)
  noteCount: number;
}

// ── Protobuf helpers ──────────────────────────────────────────────────────────

function readVarint(buf: Buffer, pos: number): { value: number; pos: number } {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * (2 ** shift); // multiplication avoids JS 32-bit signed int truncation from <<
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value: result, pos };
}

// Walk a flat protobuf buffer and return the value bytes of the first field
// matching fieldNum with wire type 2 (length-delimited). Returns null if not found.
function findField(buf: Buffer, fieldNum: number): Buffer | null {
  let pos = 0;
  while (pos < buf.length) {
    const tagR = readVarint(buf, pos);
    if (tagR.pos === pos) break;
    pos = tagR.pos;
    const wireType = tagR.value & 0x7;
    const fNum = tagR.value >> 3;
    if (wireType === 0) {
      const r = readVarint(buf, pos);
      pos = r.pos;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const lenR = readVarint(buf, pos);
      pos = lenR.pos;
      const len = lenR.value;
      if (len < 0 || pos + len > buf.length) break;
      if (fNum === fieldNum) return buf.slice(pos, pos + len);
      pos += len;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return null;
}

// Collect all len-delimited fields with the given field number (all occurrences)
function findAllField(buf: Buffer, fieldNum: number): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagR = readVarint(buf, pos);
    if (tagR.pos === pos) break;
    pos = tagR.pos;
    const wt = tagR.value & 0x7;
    const fn = tagR.value >> 3;
    if (wt === 0) { pos = readVarint(buf, pos).pos; }
    else if (wt === 1) { pos += 8; }
    else if (wt === 2) {
      const lenR = readVarint(buf, pos); pos = lenR.pos;
      const len = lenR.value;
      if (len < 0 || pos + len > buf.length) break;
      if (fn === fieldNum) out.push(buf.slice(pos, pos + len));
      pos += len;
    } else if (wt === 5) { pos += 4; }
    else break;
  }
  return out;
}

// Read the first wire-type-0 (varint) value for a given field number
function getVarintField(buf: Buffer, fieldNum: number): number | null {
  let pos = 0;
  while (pos < buf.length) {
    const tagR = readVarint(buf, pos);
    if (tagR.pos === pos) break;
    pos = tagR.pos;
    const wt = tagR.value & 0x7;
    const fn = tagR.value >> 3;
    if (wt === 0) {
      const r = readVarint(buf, pos); pos = r.pos;
      if (fn === fieldNum) return r.value;
    } else if (wt === 1) { pos += 8; }
    else if (wt === 2) {
      const lenR = readVarint(buf, pos); pos = lenR.pos;
      const len = lenR.value;
      if (len < 0 || pos + len > buf.length) break;
      pos += len;
    } else if (wt === 5) { pos += 4; }
    else break;
  }
  return null;
}

// Prefix checklist-item lines with "- [x] " or "- [ ] " using paragraph metadata.
// note_text_message.field5 (repeated) = per-span metadata.
// Each entry: { field1: charLen, field2: { field5: { field1: UUID, field2: done } } }
// Spans without field2.field5 are plain/dash-list paragraphs — left untouched.
function applyTodoMarkers(text: string, noteTextMsg: Buffer): string {
  const paraEntries = findAllField(noteTextMsg, 5);
  if (paraEntries.length === 0) return text;

  // Build per-char todo state: null=plain, false=unchecked todo, true=checked todo
  const todoAt: (boolean | null)[] = new Array(text.length + 1).fill(null);
  let charPos = 0;

  for (const entry of paraEntries) {
    const len = getVarintField(entry, 1) ?? 0;
    if (len <= 0) continue;
    const f2 = findField(entry, 2);
    if (f2) {
      const todoRef = findField(f2, 5); // field5 inside field2 = todo reference
      if (todoRef) {
        const done = (getVarintField(todoRef, 2) ?? 0) === 1;
        const end = Math.min(charPos + len, todoAt.length);
        for (let i = charPos; i < end; i++) todoAt[i] = done;
      }
    }
    charPos += len;
  }

  // Rewrite lines: prepend marker for non-empty todo lines
  const lines = text.split('\n');
  let lineStart = 0;
  const out: string[] = [];
  for (const line of lines) {
    const state = lineStart < todoAt.length ? todoAt[lineStart] : null;
    out.push(state !== null && line.length > 0
      ? (state ? '- [x] ' : '- [ ] ') + line.trimEnd()
      : line.trimEnd());
    lineStart += line.length + 1;
  }
  return out.join('\n');
}

function decodeNoteBody(data: Buffer): string {
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(data);
  } catch {
    try {
      decompressed = inflateSync(data);
    } catch {
      return ""; // encrypted blob — caller guards locked notes; empty triggers AS fallback
    }
  }

  // Deterministic navigation through the Apple Notes protobuf schema:
  //   top-level field 2  →  outer document
  //   outer-doc field 3  →  note_text_message
  //   note_text field 2  →  pure UTF-8 text string (no attribute runs)
  const outerDoc = findField(decompressed, 2);
  if (!outerDoc) return "";
  const noteTextMsg = findField(outerDoc, 3);
  if (!noteTextMsg) return "";
  const textBytes = findField(noteTextMsg, 2);
  if (!textBytes) return "";
  const text = textBytes.toString("utf8");
  return applyTodoMarkers(text, noteTextMsg);
}

// Decoding is a gunzip + protobuf walk, not free on a large note — cache the
// result keyed on (Z_PK, mod_date). mod_date changes whenever the note's
// content changes, so a stale cache entry is naturally never served: an edit
// produces a new key, not an invalidation race to get right.
const decodedBodyCache = new Map<string, string>();

function decodeNoteBodyCached(zpk: number, modDate: number | null, data: Buffer): string {
  const key = `${zpk}:${modDate ?? 0}`;
  const cached = decodedBodyCache.get(key);
  if (cached !== undefined) return cached;
  const body = decodeNoteBody(data);
  decodedBodyCache.set(key, body);
  return body;
}

// ── DB open helper ────────────────────────────────────────────────────────────

function openDbUncached(): { db: Database.Database; cleanup: () => void } {
  let tmpDir: string | null = null;
  let dbFile = DB_PATH;

  // If the DB is locked (WAL mode), copy it to a temp directory
  try {
    const db = new Database(dbFile, { readonly: true });
    return { db, cleanup: () => db.close() };
  } catch (err: any) {
    if (err.code === "SQLITE_BUSY" || err.code === "SQLITE_CANTOPEN") {
      // If we can't open directly (WAL lock), copy to temp
      tmpDir = mkdtempSync(join(tmpdir(), "notes-db-"));
      const tmpDb = join(tmpDir, "NoteStore.sqlite");
      try {
        for (const ext of ["", "-wal", "-shm"]) {
          const src = DB_PATH + ext;
          if (existsSync(src)) copyFileSync(src, tmpDb + ext);
        }
      } catch (copyErr: any) {
        rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(
          "Apple Notes database not accessible. Grant Full Disk Access to this application in System Settings > Privacy & Security > Full Disk Access."
        );
      }
      dbFile = tmpDb;
    } else if (err.message?.includes("EPERM") || err.code === "EPERM" || String(err).includes("EPERM")) {
      throw new Error(
        "Apple Notes database not accessible. Grant Full Disk Access to this application in System Settings > Privacy & Security > Full Disk Access."
      );
    } else {
      throw err;
    }
  }

  try {
    const db = new Database(dbFile, { readonly: true });
    return {
      db,
      cleanup: () => {
        db.close();
        if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  } catch (err: any) {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (err.message?.includes("EPERM") || err.code === "EPERM") {
      throw new Error(
        "Apple Notes database not accessible. Grant Full Disk Access to this application in System Settings > Privacy & Security > Full Disk Access."
      );
    }
    throw err;
  }
}

// ── DB connection + schema cache ────────────────────────────────────────────
// Every call used to open a fresh connection (or copy the file, if locked)
// and re-run detectSchema's several PRAGMA/COUNT queries from scratch — real
// overhead on every single tool call. Cache both, keyed on the source file's
// mtimes, so repeated calls between actual writes are free; any write to the
// live NoteStore.sqlite (main file or WAL) changes the key and forces a fresh
// open + schema re-detection, so this never serves stale data.
interface DbCacheEntry {
  db: Database.Database;
  cleanup: () => void;
  schema: SchemaInfo;
  mtimeKey: string;
}
let dbCache: DbCacheEntry | null = null;

function sourceMtimeKey(): string {
  return ["", "-wal", "-shm"]
    .map((ext) => {
      try {
        return String(statSync(DB_PATH + ext).mtimeMs);
      } catch {
        return "0";
      }
    })
    .join("|");
}

function openDb(): { db: Database.Database; schema: SchemaInfo } {
  const key = sourceMtimeKey();
  if (dbCache && dbCache.mtimeKey === key) {
    return { db: dbCache.db, schema: dbCache.schema };
  }
  if (dbCache) dbCache.cleanup();
  const { db, cleanup } = openDbUncached();
  const schema = detectSchema(db);
  dbCache = { db, cleanup, schema, mtimeKey: key };
  return { db, schema };
}

process.on("exit", () => dbCache?.cleanup());

// ── Schema detection ──────────────────────────────────────────────────────────

interface SchemaInfo {
  storeUuid: string;
  recentlyDeletedPk: Set<number>;
  colTitle1: string;
  colTitle2: string;
  colModDate: string;
  colCreateDate: string;
  colFolder: string;
  colNoteData: string;
  colDeleted: string | null;
  colIsLockedNote: string | null;
  colParent: string | null; // folder nesting (sub-folders) — null if this macOS version lacks it
  colAccount: string | null; // folder -> account FK — null if undetectable
  colPinned: string | null; // note pinned flag
  colFolderType: string | null; // distinguishes special folders (e.g. Recently Deleted) from regular ones
  accountNames: Map<number, string>; // account Z_PK -> display name (e.g. "iCloud")
  accountIdentifiers: Map<number, string>; // account Z_PK -> ZIDENTIFIER (folder name under Accounts/ on disk)
  entAttachment: number | null; // Z_ENT for ICAttachment rows
  entMedia: number | null; // Z_ENT for ICMedia rows
}

function detectSchema(db: Database.Database): SchemaInfo {
  // Get store UUID from Z_METADATA
  let storeUuid = "";
  try {
    const meta = db.prepare("SELECT Z_UUID FROM Z_METADATA LIMIT 1").get() as { Z_UUID: string } | undefined;
    storeUuid = meta?.Z_UUID ?? "";
  } catch {
    // Z_METADATA might not exist — try alternative
    try {
      const meta2 = db.prepare("SELECT * FROM Z_METADATA LIMIT 1").get() as Record<string, unknown> | undefined;
      const uuidKey = meta2 ? Object.keys(meta2).find((k) => k.toUpperCase().includes("UUID")) : undefined;
      if (uuidKey && meta2) storeUuid = String(meta2[uuidKey] ?? "");
    } catch {
      // proceed without UUID
    }
  }

  // Detect available columns in ZICCLOUDSYNCINGOBJECT
  const cols = db.prepare("PRAGMA table_info(ZICCLOUDSYNCINGOBJECT)").all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name.toUpperCase()));

  // Title columns — tolerate naming variations across macOS versions
  const colTitle1 = colNames.has("ZTITLE1") ? "ZTITLE1" : colNames.has("ZTITLE") ? "ZTITLE" : "ZTITLE1";
  const colTitle2 = colNames.has("ZTITLE2") ? "ZTITLE2" : "ZTITLE2";

  // Detect modification date column — try in order of preference
  let colModDate = "ZMODIFICATIONDATE";
  if (colNames.has("ZMODIFICATIONDATE1")) {
    colModDate = "ZMODIFICATIONDATE1";
  } else if (colNames.has("ZMODIFICATIONDATE")) {
    colModDate = "ZMODIFICATIONDATE";
  }

  // Detect creation date column by checking which actually has populated data
  let colCreateDate = "ZCREATIONDATE";
  const createDateCandidates = ["ZCREATIONDATE3", "ZCREATIONDATE1", "ZCREATIONDATE2", "ZCREATIONDATE"];
  for (const candidate of createDateCandidates) {
    if (colNames.has(candidate)) {
      try {
        const result = db
          .prepare(`SELECT COUNT(*) as cnt FROM ZICCLOUDSYNCINGOBJECT WHERE ${candidate} IS NOT NULL AND ZNOTEDATA IS NOT NULL LIMIT 1`)
          .get() as { cnt: number };
        if (result.cnt > 0) {
          colCreateDate = candidate;
          break;
        }
      } catch {
        // column doesn't work, try next
      }
    }
  }

  const colFolder = "ZFOLDER";
  const colNoteData = "ZNOTEDATA";
  const colDeleted = colNames.has("ZMARKEDFORDELETION") ? "ZMARKEDFORDELETION" : null;

  // Detect locked-note column
  const lockedCandidates = ["ZISPASSWORDPROTECTED", "ZLOCKEDBYPASSCODE", "ZISLOCKEDWITHPASSWORD"];
  const colIsLockedNote = lockedCandidates.find((c) => colNames.has(c)) ?? null;

  const colParent = colNames.has("ZPARENT") ? "ZPARENT" : null;
  const colPinned = colNames.has("ZISPINNED") ? "ZISPINNED" : null;
  const colFolderType = colNames.has("ZFOLDERTYPE") ? "ZFOLDERTYPE" : null;

  // Folder -> account FK has been renumbered across macOS versions (ZACCOUNT..ZACCOUNT8);
  // pick whichever candidate actually has populated values on folder rows.
  const accountColCandidates = [
    "ZACCOUNT8", "ZACCOUNT7", "ZACCOUNT6", "ZACCOUNT5",
    "ZACCOUNT4", "ZACCOUNT3", "ZACCOUNT2", "ZACCOUNT1", "ZACCOUNT",
  ];
  let colAccount: string | null = null;
  for (const candidate of accountColCandidates) {
    if (!colNames.has(candidate)) continue;
    try {
      const result = db
        .prepare(`SELECT COUNT(*) as cnt FROM ZICCLOUDSYNCINGOBJECT WHERE ${colTitle2} IS NOT NULL AND ${candidate} IS NOT NULL`)
        .get() as { cnt: number };
      if (result.cnt > 0) {
        colAccount = candidate;
        break;
      }
    } catch {
      // column doesn't work, try next
    }
  }

  // Account display names + identifiers: ICAccount rows live in the same unified
  // table, keyed by a dynamically-resolved Z_ENT (its numeric value shifts across
  // schema versions). ZIDENTIFIER is the account's folder name under
  // Accounts/ on disk — needed to resolve attachment file paths.
  const accountNames = new Map<number, string>();
  const accountIdentifiers = new Map<number, string>();
  try {
    const entRow = db.prepare("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICAccount'").get() as
      | { Z_ENT: number }
      | undefined;
    if (entRow) {
      const rows = db
        .prepare(`SELECT Z_PK, ZNAME, ZIDENTIFIER FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = ?`)
        .all(entRow.Z_ENT) as { Z_PK: number; ZNAME: string | null; ZIDENTIFIER: string | null }[];
      rows.forEach((r) => {
        accountNames.set(r.Z_PK, r.ZNAME ?? "");
        if (r.ZIDENTIFIER) accountIdentifiers.set(r.Z_PK, r.ZIDENTIFIER);
      });
    }
  } catch {
    // proceed without account names
  }

  // Attachment/media entity ids, resolved the same dynamic way as ICAccount above.
  function resolveEnt(name: string): number | null {
    try {
      const row = db.prepare("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = ?").get(name) as
        | { Z_ENT: number }
        | undefined;
      return row?.Z_ENT ?? null;
    } catch {
      return null;
    }
  }
  const entAttachment = resolveEnt("ICAttachment");
  const entMedia = resolveEnt("ICMedia");

  // Detect recently-deleted folder PKs
  const recentlyDeletedPk = new Set<number>();

  // Check for a dedicated "is recently deleted" column on folders
  const rdFolderColCandidates = [
    "ZNOTESSTOREISRECENTLYDELETEDFOLDER",
    "ZISRECENTLYDELETEDFOLDER",
    "ZISRECENTLYDELETED",
    "ZRECENTLYDELETEDFOLDERENABLED",
  ];
  const rdFolderCol = rdFolderColCandidates.find((c) => colNames.has(c)) ?? null;

  if (rdFolderCol) {
    try {
      const rows = db
        .prepare(`SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ${rdFolderCol} = 1`)
        .all() as { Z_PK: number }[];
      rows.forEach((r) => recentlyDeletedPk.add(r.Z_PK));
    } catch {
      // ignore
    }
  }

  // Also match by known localized folder titles
  const rdTitles = ["Recently Deleted", "Onlangs verwijderd", "Recent verwijderd", "Recentelijk verwijderd"];
  try {
    const placeholders = rdTitles.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ${colTitle2} IN (${placeholders}) AND ${colNoteData} IS NULL`
      )
      .all(...rdTitles) as { Z_PK: number }[];
    rows.forEach((r) => recentlyDeletedPk.add(r.Z_PK));
  } catch {
    // ignore
  }

  return {
    storeUuid,
    recentlyDeletedPk,
    colTitle1,
    colTitle2,
    colModDate,
    colCreateDate,
    colFolder,
    colNoteData,
    colDeleted,
    colIsLockedNote,
    colParent,
    colAccount,
    colPinned,
    colFolderType,
    accountNames,
    accountIdentifiers,
    entAttachment,
    entMedia,
  };
}

// ── Timestamp conversion ──────────────────────────────────────────────────────

function coreDataToISO(ts: number | null): string {
  if (ts == null || ts === 0) return "";
  const unixMs = (ts + CORE_DATA_EPOCH_OFFSET) * 1000;
  return new Date(unixMs).toISOString();
}

// ── Public API ────────────────────────────────────────────────────────────────

function buildFolderId(zpk: number, storeUuid: string): string {
  if (storeUuid) return `x-coredata://${storeUuid}/ICFolder/p${zpk}`;
  return `icfolder:${zpk}`;
}

export function readFolders(): FolderRecord[] {
  const { db, schema } = openDb();

    const parentCol = schema.colParent ? `${schema.colParent}` : "NULL";
    const accountCol = schema.colAccount ? `${schema.colAccount}` : "NULL";
    const typeCol = schema.colFolderType ? `${schema.colFolderType}` : "NULL";
    // A deleted folder isn't purged from this table right away — it's left behind
    // with colDeleted=1 (soft-delete, pending sync/purge) — so this must be
    // excluded explicitly or deleted folders leak into the result forever.
    // Note: this column can itself take well over a minute to flip to 1 after
    // an AppleScript `delete` (observed 60s+, seemingly pending an iCloud sync
    // round-trip — much longer than the ~5s SQLite lag seen for renames/
    // creates elsewhere in this file). Notes.app's own live state (what
    // AppleScript sees) always reflects the delete instantly; only this SQLite
    // read path lags.
    const deletedFilter = schema.colDeleted ? `AND (${schema.colDeleted} IS NULL OR ${schema.colDeleted} = 0)` : "";
    const sql = `
      SELECT
        Z_PK,
        ${schema.colTitle2} AS folder_name,
        ${parentCol} AS parent_pk,
        ${accountCol} AS account_pk,
        ${typeCol} AS folder_type
      FROM ZICCLOUDSYNCINGOBJECT
      WHERE ${schema.colNoteData} IS NULL
        AND ${schema.colTitle2} IS NOT NULL
        ${deletedFilter}
    `;

    const rows = db.prepare(sql).all() as {
      Z_PK: number;
      folder_name: string | null;
      parent_pk: number | null;
      account_pk: number | null;
      folder_type: number | null;
    }[];

    // Count non-deleted notes per folder
    const deletedCols = schema.colDeleted ? `AND (${schema.colDeleted} IS NULL OR ${schema.colDeleted} = 0)` : "";
    const countStmt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM ZICCLOUDSYNCINGOBJECT WHERE ${schema.colFolder} = ? AND ${schema.colNoteData} IS NOT NULL ${deletedCols}`
    );

    const byPk = new Map(rows.map((r) => [r.Z_PK, r]));
    function pathFor(r: (typeof rows)[number]): string {
      const segments = [r.folder_name ?? ""];
      let cur = r;
      const seen = new Set<number>([r.Z_PK]); // guards against a cyclic ZPARENT chain
      while (cur.parent_pk != null && byPk.has(cur.parent_pk) && !seen.has(cur.parent_pk)) {
        const parent = byPk.get(cur.parent_pk)!;
        segments.unshift(parent.folder_name ?? "");
        seen.add(parent.Z_PK);
        cur = parent;
      }
      return segments.join("/");
    }

    return rows
      .filter((r) => r.folder_name && !schema.recentlyDeletedPk.has(r.Z_PK))
      .map((r) => {
        const count = (countStmt.get(r.Z_PK) as { cnt: number }).cnt;
        return {
          id: buildFolderId(r.Z_PK, schema.storeUuid),
          name: r.folder_name!,
          path: pathFor(r),
          account: r.account_pk != null ? (schema.accountNames.get(r.account_pk) ?? "") : "",
          isSmartFolder: r.folder_type === 1,
          noteCount: count,
        };
      });
}

interface RawNoteQueryResult {
  Z_PK: number;
  ZIDENTIFIER: string | null;
  note_name: string | null;
  folder_pk: number | null;
  folder_name: string | null;
  create_date: number | null;
  mod_date: number | null;
  ZDATA: Buffer | null;
  is_locked: number | null;
  is_pinned: number | null;
}

function buildNoteQuery(schema: SchemaInfo, withBody: boolean): string {
  const lockedCol = schema.colIsLockedNote ? `n.${schema.colIsLockedNote}` : "NULL";
  const pinnedCol = schema.colPinned ? `n.${schema.colPinned}` : "NULL";
  const deletedFilter = schema.colDeleted
    ? `AND (n.${schema.colDeleted} IS NULL OR n.${schema.colDeleted} = 0)`
    : "";

  if (withBody) {
    return `
      SELECT
        n.Z_PK,
        n.ZIDENTIFIER,
        n.${schema.colTitle1} AS note_name,
        n.${schema.colFolder} AS folder_pk,
        f.${schema.colTitle2} AS folder_name,
        n.${schema.colCreateDate} AS create_date,
        n.${schema.colModDate} AS mod_date,
        d.ZDATA,
        ${lockedCol} AS is_locked,
        ${pinnedCol} AS is_pinned
      FROM ZICCLOUDSYNCINGOBJECT n
      LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.${schema.colFolder}
      LEFT JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
      WHERE n.${schema.colNoteData} IS NOT NULL
        ${deletedFilter}
    `;
  }

  return `
    SELECT
      n.Z_PK,
      n.ZIDENTIFIER,
      n.${schema.colTitle1} AS note_name,
      n.${schema.colFolder} AS folder_pk,
      f.${schema.colTitle2} AS folder_name,
      n.${schema.colCreateDate} AS create_date,
      n.${schema.colModDate} AS mod_date,
      NULL AS ZDATA,
      ${lockedCol} AS is_locked,
      ${pinnedCol} AS is_pinned
    FROM ZICCLOUDSYNCINGOBJECT n
    LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.${schema.colFolder}
    WHERE n.${schema.colNoteData} IS NOT NULL
      ${deletedFilter}
  `;
}

function rowToNoteRow(r: RawNoteQueryResult, schema: SchemaInfo): NoteRow {
  const folderPk = r.folder_pk ?? 0;
  const folder = schema.recentlyDeletedPk.has(folderPk) ? null : (r.folder_name ?? "");
  return {
    id: buildId(r.Z_PK, schema.storeUuid),
    name: r.note_name ?? "",
    folder: folder ?? "(Recently Deleted)",
    creationDate: coreDataToISO(r.create_date),
    modificationDate: coreDataToISO(r.mod_date),
    pinned: r.is_pinned === 1,
  };
}

function buildId(zpk: number, storeUuid: string): string {
  if (storeUuid) return `x-coredata://${storeUuid}/ICNote/p${zpk}`;
  return `icnote:${zpk}`;
}

function isRecentlyDeleted(r: RawNoteQueryResult, schema: SchemaInfo): boolean {
  const folderPk = r.folder_pk ?? 0;
  return schema.recentlyDeletedPk.has(folderPk);
}

// Recently Deleted notes are excluded everywhere else in this file (they're
// filtered out via isRecentlyDeleted); this is the one reader that returns them.
export function readRecentlyDeleted(): Array<NoteRow & { body: string }> {
  const { db, schema } = openDb();
    const lockedCol = schema.colIsLockedNote ? `n.${schema.colIsLockedNote}` : "NULL";
    const pinnedCol = schema.colPinned ? `n.${schema.colPinned}` : "NULL";
    const rows = db
      .prepare(
        `SELECT n.Z_PK, n.ZIDENTIFIER, n.${schema.colTitle1} AS note_name,
                n.${schema.colFolder} AS folder_pk, f.${schema.colTitle2} AS folder_name,
                n.${schema.colCreateDate} AS create_date, n.${schema.colModDate} AS mod_date,
                d.ZDATA, ${lockedCol} AS is_locked, ${pinnedCol} AS is_pinned
         FROM ZICCLOUDSYNCINGOBJECT n
         LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.${schema.colFolder}
         LEFT JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
         WHERE n.${schema.colNoteData} IS NOT NULL`
      )
      .all() as RawNoteQueryResult[];
    return rows
      .filter((r) => isRecentlyDeleted(r, schema))
      .map((r) => {
        const base = rowToNoteRow(r, schema);
        const body = r.is_locked ? "[locked]" : r.ZDATA ? decodeNoteBodyCached(r.Z_PK, r.mod_date, r.ZDATA) : "";
        return { ...base, body };
      });
}

export function readAllNotes(withBody: boolean): NoteRow[] {
  const { db, schema } = openDb();
    const sql = buildNoteQuery(schema, withBody);
    const rows = db.prepare(sql).all() as RawNoteQueryResult[];
    return rows
      .filter((r) => !isRecentlyDeleted(r, schema))
      .map((r) => rowToNoteRow(r, schema));
}

export function readAllNotesWithBody(): Array<NoteRow & { body: string }> {
  const { db, schema } = openDb();
    const sql = buildNoteQuery(schema, true);
    const rows = db.prepare(sql).all() as RawNoteQueryResult[];
    return rows
      .filter((r) => !isRecentlyDeleted(r, schema))
      .map((r) => {
        const base = rowToNoteRow(r, schema);
        let body = "";
        if (r.is_locked) {
          body = "[locked]";
        } else if (r.ZDATA) {
          body = decodeNoteBodyCached(r.Z_PK, r.mod_date, r.ZDATA);
        }
        return { ...base, body };
      });
}

export function readFolderWithBodies(
  folder?: string,
  maxCharsPerBody?: number
): Array<NoteRow & { body: string; truncated: boolean }> {
  const { db, schema } = openDb();
    const sql = buildNoteQuery(schema, true);
    const rows = db.prepare(sql).all() as RawNoteQueryResult[];
    return rows
      .filter((r) => !isRecentlyDeleted(r, schema))
      .filter((r) => !folder || (r.folder_name ?? "") === folder)
      .map((r) => {
        const base = rowToNoteRow(r, schema);
        let body = "";
        if (r.is_locked) {
          body = "[locked]";
        } else if (r.ZDATA) {
          body = decodeNoteBodyCached(r.Z_PK, r.mod_date, r.ZDATA);
        }
        let truncated = false;
        if (maxCharsPerBody != null && body.length > maxCharsPerBody) {
          body = body.slice(0, maxCharsPerBody);
          truncated = true;
        }
        return { ...base, body, truncated };
      });
}

// Attachment media files live at:
//   Accounts/{account ZIDENTIFIER}/Media/{media ZIDENTIFIER}/{media ZGENERATION1}/{media ZFILENAME}
// (confirmed live against a real library). accountPk should come from the
// note's folder, not the attachment's own account column — that column has
// been renumbered across schema versions the same way folders' has, and
// piggybacking on the already-detected folder->account link avoids detecting
// it a second time.
function buildAttachmentFilePath(
  schema: SchemaInfo,
  accountPk: number | null,
  mediaIdentifier: string | null,
  generation: string | null,
  filename: string | null
): string | null {
  if (accountPk == null || !mediaIdentifier || !filename) return null;
  const accountId = schema.accountIdentifiers.get(accountPk);
  if (!accountId) return null;
  const filePath = join(
    homedir(),
    "Library/Group Containers/group.com.apple.notes/Accounts",
    accountId,
    "Media",
    mediaIdentifier,
    generation ?? "",
    filename
  );
  return existsSync(filePath) ? filePath : null;
}

interface RawAttachmentRow {
  att_id: string | null;
  type_uti: string | null;
  ocr: string | null;
  media_id: string | null;
  filename: string | null;
  generation: string | null;
}

function rowToAttachmentInfo(r: RawAttachmentRow, schema: SchemaInfo, accountPk: number | null): AttachmentInfo {
  return {
    id: r.media_id ?? r.att_id ?? "",
    filename: r.filename ?? "",
    typeUTI: r.type_uti ?? "",
    filePath: buildAttachmentFilePath(schema, accountPk, r.media_id, r.generation, r.filename),
    ocrText: r.ocr && r.ocr.trim() ? r.ocr.trim() : null,
  };
}

// Bulk OCR text per note (one attachment scan, not one query per note) — used
// to fold image-recognized text into the searchable corpus for notes_search.
export function readOcrTextByNote(): Map<number, string> {
  const { db, schema } = openDb();
    const map = new Map<number, string>();
    if (schema.entAttachment == null) return map;
    const deletedFilter = schema.colDeleted
      ? `AND (${schema.colDeleted} IS NULL OR ${schema.colDeleted} = 0)`
      : "";
    const rows = db
      .prepare(
        `SELECT ZNOTE AS note_pk, ZOCRSUMMARY AS ocr
         FROM ZICCLOUDSYNCINGOBJECT
         WHERE Z_ENT = ? AND ZNOTE IS NOT NULL AND ZOCRSUMMARY IS NOT NULL AND ZOCRSUMMARY != '' ${deletedFilter}`
      )
      .all(schema.entAttachment) as { note_pk: number; ocr: string }[];
    for (const r of rows) {
      const prev = map.get(r.note_pk);
      map.set(r.note_pk, prev ? `${prev} ${r.ocr}` : r.ocr);
    }
    return map;
}

export function readAttachments(noteZpk: number): AttachmentInfo[] {
  const { db, schema } = openDb();
    if (schema.entAttachment == null) return [];

    const noteRow = db
      .prepare(`SELECT ${schema.colFolder} AS folder_pk FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ?`)
      .get(noteZpk) as { folder_pk: number | null } | undefined;
    let accountPk: number | null = null;
    if (noteRow?.folder_pk != null && schema.colAccount) {
      const folderRow = db
        .prepare(`SELECT ${schema.colAccount} AS account_pk FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ?`)
        .get(noteRow.folder_pk) as { account_pk: number | null } | undefined;
      accountPk = folderRow?.account_pk ?? null;
    }

    const deletedFilter = schema.colDeleted
      ? `AND (a.${schema.colDeleted} IS NULL OR a.${schema.colDeleted} = 0)`
      : "";
    const mediaJoin = schema.entMedia != null ? "LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK = a.ZMEDIA" : "";
    const mediaCols = schema.entMedia != null
      ? "m.ZIDENTIFIER AS media_id, m.ZFILENAME AS filename, m.ZGENERATION1 AS generation"
      : "NULL AS media_id, NULL AS filename, NULL AS generation";

    const rows = db
      .prepare(
        `SELECT a.ZIDENTIFIER AS att_id, a.ZTYPEUTI AS type_uti, a.ZOCRSUMMARY AS ocr, ${mediaCols}
         FROM ZICCLOUDSYNCINGOBJECT a
         ${mediaJoin}
         WHERE a.Z_ENT = ? AND a.ZNOTE = ? ${deletedFilter}`
      )
      .all(schema.entAttachment, noteZpk) as RawAttachmentRow[];

    return rows.map((r) => rowToAttachmentInfo(r, schema, accountPk));
}

// Looks up one attachment by its media identifier (preferred — what
// readAttachments returns as `id`) or its own attachment identifier, across
// every note, since notes_get_attachment only receives the id.
export function readAttachmentByIdentifier(identifier: string): AttachmentInfo | null {
  const { db, schema } = openDb();
    if (schema.entAttachment == null) return null;

    const noteFolderCol = schema.colFolder;
    const mediaJoin = schema.entMedia != null ? "LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK = a.ZMEDIA" : "";
    const mediaCols = schema.entMedia != null
      ? "m.ZIDENTIFIER AS media_id, m.ZFILENAME AS filename, m.ZGENERATION1 AS generation"
      : "NULL AS media_id, NULL AS filename, NULL AS generation";

    const row = db
      .prepare(
        `SELECT a.ZIDENTIFIER AS att_id, a.ZTYPEUTI AS type_uti, a.ZOCRSUMMARY AS ocr, a.ZNOTE AS note_pk, ${mediaCols}
         FROM ZICCLOUDSYNCINGOBJECT a
         ${mediaJoin}
         WHERE a.Z_ENT = ? AND (a.ZIDENTIFIER = ? OR m.ZIDENTIFIER = ?)`
      )
      .get(schema.entAttachment, identifier, identifier) as (RawAttachmentRow & { note_pk: number | null }) | undefined;
    if (!row) return null;

    let accountPk: number | null = null;
    if (row.note_pk != null) {
      const noteRow = db
        .prepare(`SELECT ${noteFolderCol} AS folder_pk FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ?`)
        .get(row.note_pk) as { folder_pk: number | null } | undefined;
      if (noteRow?.folder_pk != null && schema.colAccount) {
        const folderRow = db
          .prepare(`SELECT ${schema.colAccount} AS account_pk FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ?`)
          .get(noteRow.folder_pk) as { account_pk: number | null } | undefined;
        accountPk = folderRow?.account_pk ?? null;
      }
    }

    return rowToAttachmentInfo(row, schema, accountPk);
}

export function readNoteById(zpk: number): (NoteRow & { body: string }) | null;
export function readNoteById(zpk: number, withBody: true): (NoteRow & { body: string }) | null;
export function readNoteById(zpk: number, withBody = true): (NoteRow & { body: string }) | null {
  const { db, schema } = openDb();
    const lockedCol = schema.colIsLockedNote ? `n.${schema.colIsLockedNote}` : "NULL";
    const pinnedCol = schema.colPinned ? `n.${schema.colPinned}` : "NULL";
    const row = db
      .prepare(
        `SELECT n.Z_PK, n.ZIDENTIFIER, n.${schema.colTitle1} AS note_name,
                n.${schema.colFolder} AS folder_pk, f.${schema.colTitle2} AS folder_name,
                n.${schema.colCreateDate} AS create_date, n.${schema.colModDate} AS mod_date,
                d.ZDATA, ${lockedCol} AS is_locked, ${pinnedCol} AS is_pinned
         FROM ZICCLOUDSYNCINGOBJECT n
         LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.${schema.colFolder}
         LEFT JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
         WHERE n.Z_PK = ? AND n.${schema.colNoteData} IS NOT NULL`
      )
      .get(zpk) as RawNoteQueryResult | undefined;

    if (!row || isRecentlyDeleted(row, schema)) return null;
    const base = rowToNoteRow(row, schema);
    let body = "";
    if (row.is_locked) {
      body = "[locked]";
    } else if (withBody && row.ZDATA) {
      body = decodeNoteBodyCached(row.Z_PK, row.mod_date, row.ZDATA);
    }
    return { ...base, body };
}

export function readNoteByTitle(title: string): (NoteRow & { body: string }) | null {
  const { db, schema } = openDb();
    const lockedCol = schema.colIsLockedNote ? `n.${schema.colIsLockedNote}` : "NULL";
    const pinnedCol = schema.colPinned ? `n.${schema.colPinned}` : "NULL";
    const row = db
      .prepare(
        `SELECT n.Z_PK, n.ZIDENTIFIER, n.${schema.colTitle1} AS note_name,
                n.${schema.colFolder} AS folder_pk, f.${schema.colTitle2} AS folder_name,
                n.${schema.colCreateDate} AS create_date, n.${schema.colModDate} AS mod_date,
                d.ZDATA, ${lockedCol} AS is_locked, ${pinnedCol} AS is_pinned
         FROM ZICCLOUDSYNCINGOBJECT n
         LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.${schema.colFolder}
         LEFT JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK
         WHERE n.${schema.colTitle1} = ? AND n.${schema.colNoteData} IS NOT NULL
         LIMIT 1`
      )
      .get(title) as RawNoteQueryResult | undefined;

    if (!row || isRecentlyDeleted(row, schema)) return null;
    const base = rowToNoteRow(row, schema);
    let body = "";
    if (row.is_locked) {
      body = "[locked]";
    } else if (row.ZDATA) {
      body = decodeNoteBodyCached(row.Z_PK, row.mod_date, row.ZDATA);
    }
    return { ...base, body };
}
