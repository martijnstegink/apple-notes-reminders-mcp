# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (macOS-only) that exposes Apple Notes and Apple Reminders as tools to MCP clients (e.g. Claude Desktop). TypeScript, ESM, compiled with `tsc`, run under Node via stdio transport.

## Commands

```bash
npm run build         # tsc compile, src/ -> dist/
npm run build:swift   # swiftc swift/reminders-daemon.swift -o swift/reminders-daemon (also runs on npm install via postinstall)
npm start             # node dist/index.js (the MCP server, stdio transport)
```

There is no lint script and no `npm test`. Test suites are standalone scripts:

```bash
npm run build && node scripts/test-phase2.mjs             # protobuf/checklist decoder
npm run build && node scripts/test-markdown.mjs            # markdown -> Notes-HTML converter
npm run build && node scripts/test-schema-detection.mjs    # schema-detection sanity checks (live DB)
```

`scripts/test-phase2.mjs` is self-contained — it reimplements the protobuf varint/field decoder inline (mirroring `notesStore.ts`) rather than importing it, so unit-test sections (varint safety, checklist edge cases, and a set of pinned full-pipeline fixtures that gzip-compress a complete synthetic document and decode it end to end) run without touching the real Notes database. Its final section ("Real DB notes") does open the actual `dist/notesStore.js` and read specific note IDs (`p9875`, `p9656`, `p9858`) that only exist in the original author's own Notes.app — those cases will fail/error on any other machine and can be ignored when validating unrelated changes.

`scripts/test-markdown.mjs` imports `dist/markdown.js` directly and asserts exact HTML output for the markdown converter — fully deterministic, no Notes.app or SQLite access needed.

`scripts/test-schema-detection.mjs` imports `dist/notesStore.js` and asserts invariants (non-empty folder path/id/account, Recently Deleted excluded, valid date parsing, etc.) against whatever real Notes database is present — like `test-phase2.mjs`'s "Real DB notes" section, this needs Full Disk Access and actual note/folder data, so failures on a fresh or empty library are expected rather than a regression signal.

There is a manual/live-verification convention for AppleScript- and daemon-backed write paths (Notes create/update/delete/move, Reminders create/update/subtasks): exercise them only against a Notes folder and Reminders list created fresh for that run, with a unique name (e.g. `MCP-Test-<timestamp>`) — never against real data, and never a shared/persistent `MCP-Test` list or folder reused across runs, since that's exactly what produced a pile of duplicate empty `MCP-Test` Reminders lists over time. Delete both the folder and the list completely at the end of the run — in a `finally`/`afterAll` so cleanup still happens even if the run fails partway through.

## Architecture

Two domains, two very different read/write strategies:

- **Notes**: reads go straight to SQLite (`~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`); writes go through AppleScript (`osascript`) via Notes.app, because the on-disk store is owned by Notes.app and unsafe to write directly.
- **Reminders**: both reads and writes go through a persistent Swift/EventKit daemon (`swift/reminders-daemon`) talking newline-delimited JSON over stdio. Subtasks are the one exception — EventKit's public API doesn't expose them, so `reminders.ts` shells out to AppleScript just for `reminders_add_subtask`/`reminders_complete_subtask`.

### src/index.ts

Pure MCP tool registration (`server.tool(...)`) — each tool validates params with zod and delegates to `notes.ts` or `reminders.ts`. No business logic lives here. Bulk "filter-based" tools (`*_query_where`, `*_delete_where`, `*_complete_where`, `*_move_where`) let a caller describe *which* records to act on in words (folder/list, search text, due-date range, priority, completion state) instead of fetching IDs first; every mutating one refuses to act unless called again with `confirm: true`, first returning only a match count. Preserve that confirm-gate pattern when adding new bulk operations.

### src/notesStore.ts — SQLite reads + protobuf decoder

This is the subtle part of the codebase. Note bodies are stored as a gzipped protobuf blob in `ZICNOTEDATA.ZDATA`. `decodeNoteBody` decompresses it and walks the protobuf deterministically (`outer doc field 2 → note_text_message field 3 → text field 2`) rather than heuristically scanning for "the cleanest string," because the heuristic approach used to return corrupted binary for notes containing checklists.

Two correctness details to preserve if touching this decoder:
- **Varints must be accumulated with `* 2 ** shift`, never `<<`** — JS bitwise shift truncates to 32 bits and corrupts large offsets/lengths.
- **Checklist span lengths are UTF-16 code units** (`applyTodoMarkers`), matching how Apple measures string length, so markers stay aligned across multi-byte characters and emoji (surrogate pairs).

`notesStore.ts` also does defensive schema detection (`detectSchema`) because column names in `ZICCLOUDSYNCINGOBJECT` (title, date, deleted, locked, parent, account, folder-type columns) vary across macOS versions — don't hardcode a column name without checking `detectSchema` first. Entity ids (`ICAccount`, `ICAttachment`, `ICMedia`) are likewise resolved dynamically via `Z_PRIMARYKEY`/`Z_NAME`, not hardcoded `Z_ENT` numbers, for the same reason.

`openDb()` copies the live SQLite file (+ `-wal`/`-shm`) to a temp dir when it's locked, and opens read-only either way — the live NoteStore is never written or locked by this code. The open connection, the detected schema, and each note's decoded body are all cached at module scope, keyed on the source files' mtimes (connection/schema) or `(Z_PK, modification date)` (decoded body) — a write to the live NoteStore always changes the key, so this can't serve stale data; see the "DB connection + schema cache" comment block for the exact mechanism.

Folders carry a computed nested `path` (walking `ZPARENT`, guarded against cycles) and an `account` name (via the folder→account FK, itself schema-detected across `ZACCOUNT`..`ZACCOUNT8` candidates). `readFolders()` excludes soft-deleted folders (`colDeleted = 1`) — that flag can take well over a minute to actually flip after an AppleScript `delete` in the live app (seemingly pending an iCloud sync round-trip), much longer than the ~5s SQLite lag typical of other writes; don't mistake that for a caching bug.

Attachments are read from `ICAttachment` rows (`ZNOTE` FK) joined to `ICMedia` rows (`ZMEDIA`/`ZATTACHMENT1`, bidirectional FK) for filename/generation, with OCR text straight from `ZOCRSUMMARY` (plain VARCHAR, no decoding needed). The file path is built from the media row's identifier + `ZGENERATION1` + filename under `Accounts/{account ZIDENTIFIER}/Media/...` — the account identifier must come from the *note's folder*, not the attachment's own account column, since that column has been renumbered the same way folders' has and detecting it a second time would be redundant. Audio-transcript data (`ZTEMPORARYTRANSCRIPTDATA`) exists as a column but is an undecoded opaque blob — no test data was available to reverse-engineer its format.

### src/applescript.ts

Shared `runAppleScript(script, args?, timeoutMs?)` helper used by both `notes.ts` and `reminders.ts` for every `osascript` call. Every script must be written as `on run argv ... end run` and read dynamic values as `item N of argv` — **never splice user content (identifiers, names, bodies) into the script text itself**. Passing values as real process arguments means AppleScript receives them as literal strings with no quoting/escaping/newline-corruption edge cases, which is why `notes.ts`/`reminders.ts` no longer contain any `esc()`-style string-escaping helpers. Every call goes through `execFile` (async, not `execFileSync`) with a timeout — bulk operations (e.g. `actOnIds` in `notes.ts`) pass a longer `timeoutMs` matching their internal AppleScript `with timeout of N seconds` block.

Note-identifier dispatch (`asFindClause` in `notes.ts`) decides "is this an ID vs. a title" by checking for the `x-coredata://` URI prefix specifically — not a generic `includes(":")` check, since note titles can legitimately contain colons.

### src/markdown.ts

Lightweight markdown → Notes-compatible HTML converter (not a full CommonMark implementation): `#`/`##`/`###` headings, `**bold**`/`*italic*`/`_italic_`, `-`/`*` and `1.` lists, `` `code` ``, `[text](url)`, blank lines, one `<div>` per plain-text line. Unrecognized constructs degrade rather than error — table rows and `- [ ]`/`- [x]` checklist syntax fall through as literal paragraph/dash-list text (real Apple checklist state can't be set via the AppleScript `body` property — see `notesStore.ts` — so there's no point pretending to support it), and `#hashtags` inside a paragraph are left as plain text since Notes auto-links them itself once it parses the saved body. `renderBody(body, format)` dispatches on `NoteBodyFormat` ("markdown" default | "html" passthrough | "text" literal-escaped).

### src/notes.ts

Wraps `notesStore.ts` reads and adds AppleScript-based writes (create/update/delete/move/folder ops) via `src/applescript.ts`. Also contains an HTML→plain-text converter (`htmlToPlainText`) used only as a fallback: if `notes_get` gets an empty body from the SQLite decoder (unrecognized blob), it re-fetches via AppleScript's `body` property and converts that HTML — but that path loses checkbox state, since AppleScript's `body` doesn't encode it.

`createNote`/`updateNote` render `body` through `src/markdown.ts`'s `renderBody()` per a `format` param (default `"markdown"`). `createNote` does *not* prepend a title heading — Notes.app itself inserts `name:` as the body's literal first line when `make new note` is given both `name:` and `body:` together, so doing it ourselves too duplicates the title (confirmed live against `MCP-Test`). `updateNote`'s `"replace"` mode (default) *does* still prepend `<h1>{title}</h1>`, because that path only ever calls `set body of n` on an already-existing note, which re-derives the displayed title from the new body's first line instead of auto-inserting the old one — so the explicit heading is what keeps the title from drifting. `updateNote` also takes a `mode`: `"replace"` rebuilds the body from scratch; `"append"`/`"prepend"` instead fetch the note's current raw HTML via AppleScript's `body` property and concatenate the newly rendered content onto it. All three modes are guarded the same way — if the note currently has attachments, `updateNote` refuses and returns `{ applied: false, warning }` unless `force: true` — because re-submitting captured attachment markup (e.g. an `<img data:...>` `src`) through the `body` setter does not actually re-attach it (confirmed live: the attachment silently becomes orphaned even though it still counts toward `attachments of n`), so append/prepend can't safely preserve attachments either.

Folder rename/delete go through `folderResolveScript`, which walks a `"/"-separated` path one segment at a time via a hand-rolled `repeat...every folder [of parent]` scan — confirmed live that both `folder id "..."` and any `whose` filter become unreliable once a folder has been nested under another (`move`), so the scan-and-match-by-name loop is what actually works. There's no `moveFolder`: `move <folder> to <folder>` itself was confirmed unreliable in the same testing (intermittent throws or silent no-ops even for a freshly created, never-touched folder pair) — re-parenting is intentionally not implemented rather than shipped broken. Tags (`listTags`, `notes_query_where`'s `tag` filter) are derived by regex-scanning decoded bodies for literal `#word` text, not from any DB relationship — Notes stores hashtags as plain text and auto-links them itself. Recently Deleted notes are read via `Store.readRecentlyDeleted()` (the one reader that doesn't filter them out) and restored via the same `moveNote`/AppleScript path used for normal folder moves — confirmed live that a recently-deleted note's `x-coredata://` id still resolves via `note id "..."` even though it's outside the normal `notes` collection.

Adding an image attachment via this server isn't supported — a Shortcuts-CLI research spike (see the comment block at the top of the file) concluded it isn't viable as a zero-setup tool, since `shortcuts run` takes exactly one input file with no way to also pass a target note, and the CLI can only run a shortcut that already exists.

### src/reminders.ts + swift/reminders-daemon.swift

`reminders.ts` lazily spawns `swift/reminders-daemon` (a long-lived child process, built by `npm run build:swift`) and speaks JSON-per-line over its stdin/stdout, matching requests to responses by a `randomUUID()` id (see `ensureDaemon`/`call`). Every daemon call has a timeout (`CALL_TIMEOUT_MS`) that rejects and clears the pending entry so a hung daemon can't leak unresolved promises; if the daemon process exits, respawning backs off exponentially (`consecutiveFailedSpawns`, capped at `MAX_RESTART_BACKOFF_MS`) to avoid a tight crash loop. The daemon (`handleCommand` switch in `reminders-daemon.swift`) implements one case per command: `list-lists`, `list-reminders`, `create-reminder`, `*-where` filters, etc. Natural-language due dates (via `chrono-node`) are parsed to ISO strings in `reminders.ts` before being sent to the daemon — the Swift side only deals with ISO dates, never natural language. Subtask operations (`addSubtask`/`completeSubtask`) go through `src/applescript.ts` instead, following the same argv-only rule as `notes.ts`.

The compiled `swift/reminders-daemon` binary is gitignored, not committed — it's built from `swift/reminders-daemon.swift` by `npm run build:swift` (also wired into `postinstall`). If you edit the `.swift` file, rebuild before testing.

EventKit's public API has no `flagged` property, so it's read/written entirely via AppleScript (`fetchFlaggedIds`/`setReminderFlagged` in `reminders.ts`) and merged into EventKit-sourced `Reminder` objects by id. A whole-library scan is slow (AppleScript's per-property IPC overhead measured well over 90s against a real library at one point — see `FLAGGED_FULL_SCAN_TIMEOUT_MS`), so `listReminders`/`searchReminders` only merge `flagged` in when scoped to a single list; `queryRemindersWhere`/`viewReminders`/the `*_where` bulk ops pay the full-scan cost only when the caller explicitly filters on `flagged`, and the bulk ops (`delete/complete/move-where`) fall back to per-id calls in that case since the daemon's native filter can't express it.

The daemon's `parseDate`/`parseISODate` must accept fractional-second ISO timestamps (`"...T00:00:00.000Z"`) — a plain `ISO8601DateFormatter()` silently rejects them (`.withFractionalSeconds` isn't in its default `formatOptions`), which was a real, previously-undetected bug: every due date sent from Node (`Date#toISOString()` always includes milliseconds) was silently dropped. Fixed via a shared `parseISODate()` that tries the fractional-seconds formatter first, falling back to the plain one.

`reminders_view` (today/planned/overdue/urgent/flagged/completed) and recurrence/early-alarm/location-alarm support are built on top of the same `create-reminder`/`update-reminder`/`query-where` commands — recurrence needs `startDateComponents` set alongside `dueDateComponents` for EventKit to anchor it, and location alarms use `EKAlarm.structuredLocation` + `.proximity`. Reminder templates and saved filter "views" (`reminders_save_template`/`reminders_save_view` and friends) are pure server-side emulation — JSON files under `~/.apple-notes-reminders-mcp/`, since EventKit has no such concept; there's nothing in the daemon for these.

## Permissions this server needs at runtime

- Automation permission for the host app (e.g. Claude Desktop) to control Notes.app/Reminders.app (AppleScript + EventKit)
- Full Disk Access for the host app, to read `NoteStore.sqlite` directly

Both are macOS privacy gates, not something code can work around — if a reader is debugging "can't access Notes/Reminders" failures, point at System Settings › Privacy & Security first.
