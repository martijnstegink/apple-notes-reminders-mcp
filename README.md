# apple-notes-reminders-mcp

An MCP (Model Context Protocol) server that exposes **Apple Notes** and **Apple Reminders** to MCP-compatible clients (e.g. Claude Desktop) on macOS.

## What it does

The server registers a set of tools for reading and writing Notes and Reminders. Notes tools cover listing, searching (including recognized text inside image attachments), reading, creating, updating, moving, and deleting notes and folders, plus tags, pinned status, image attachments, and Recently Deleted. Reminders tools cover the equivalent operations plus subtasks, batch creation, completion, due dates, flags, recurrence, location/early alarms, saved filter views, templates, and bulk word-based filters.

## Architecture

The two domains are read and written through different mechanisms:

**Reads** go through SQLite where possible. Notes are read directly from the on-disk NoteStore database:

```
~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite
```

The database is copied to a temporary location and opened read-only, so the live store is never touched or locked. Note bodies are stored as a gzipped protobuf blob in `ZICNOTEDATA.ZDATA`; the decoder decompresses this and navigates the protobuf structure deterministically to extract text and formatting metadata.

**Writes** go through AppleScript (`osascript`). The NoteStore database is owned by Notes.app and cannot be written to safely from outside, so create/update/delete/move operations are delegated to Notes.app via AppleScript. Reminder subtasks also use AppleScript, because the public EventKit API does not expose them.

### Note body decoding

Reading a note body correctly is the subtle part of this project. The body is not plain text — it is a protobuf message inside the gzipped blob. The decoder:

1. Decompresses `ZDATA` and navigates deterministically to the note-text message (`document → field 2 → field 3`), then reads the text string (`field 2`). This replaced an earlier heuristic that scanned for the "cleanest" string candidate and returned corrupted binary for notes containing checklists.
2. Walks the repeated per-span paragraph metadata to detect checklist items and their done/undone state, prefixing checked items with `- [x] ` and unchecked items with `- [ ] `.

Two details matter for correctness:

- **Varints** are accumulated with multiplication (`* 2 ** shift`) rather than the `<<` operator, because JavaScript's bitwise shift truncates to 32 bits and corrupts large offsets.
- **Span lengths** are measured in UTF-16 code units, matching how Apple stores them, so checklist markers stay aligned even when the text contains multi-byte characters or emoji.

If SQLite decoding fails for any reason, `notes_get` falls back to reading the note body via AppleScript, which returns clean text but cannot recover checkbox state (Apple's AppleScript `body` property does not encode it).

### Attachments

Image attachments are read from `ZICCLOUDSYNCINGOBJECT`'s `ICAttachment`/`ICMedia` rows (resolved dynamically via `Z_PRIMARYKEY`/`Z_ENT`, not hardcoded, since the numeric entity ids and the `ZACCOUNT*`/`ZPARENT` column names shift across macOS versions). The actual file lives on disk at:

```
~/Library/Group Containers/group.com.apple.notes/Accounts/{account}/Media/{media id}/{generation}/{filename}
```

`notes_get` returns each attachment's id, filename, type, resolved file path, and any recognized OCR text; `notes_get_attachment` fetches an image attachment as an MCP image content block. `notes_search` folds OCR text into the search corpus, so text that only appears inside a screenshot is findable. Adding an attachment isn't supported — see "Known limitations" below.

### Reminders' `flagged` and other AppleScript-only reads

EventKit's public API has no `flagged` property, so it's read and written entirely via AppleScript and merged into EventKit-sourced `Reminder` objects by id. A whole-library flagged scan is comparatively slow (AppleScript's per-property IPC overhead), so `reminders_list`/`reminders_search` only include `flagged` when scoped to a single list; use `reminders_query_where`/`reminders_view` with an explicit `flagged` filter when you need it across every list.

### Caching

`notesStore.ts` caches the open SQLite connection, the detected schema, and each note's decoded body, all invalidated by comparing the source file's (and its `-wal`/`-shm` sidecars') mtimes on every call — a write to the live NoteStore always busts the cache, so this is a pure performance win, not a staleness risk. Decoded bodies are additionally keyed on `(Z_PK, modification date)`, so an edited note gets a fresh cache entry rather than a stale hit.

## Requirements & permissions

- **macOS** (tested on macOS 26 / Tahoe)
- **Node.js 18+** (uses `better-sqlite3` for SQLite access)
- Notes.app and Reminders.app set up and signed in to an account
- **Automation permission**: the host application (e.g. Claude Desktop) must be allowed to control Notes and Reminders — macOS will prompt on first use, or grant it in System Settings › Privacy & Security › Automation
- **Full Disk Access**: required for the host application to read the NoteStore database at `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite` — grant it in System Settings › Privacy & Security › Full Disk Access

### macOS version notes

Column names and numeric entity ids inside `ZICCLOUDSYNCINGOBJECT` shift across macOS/Notes.app versions (e.g. `ZACCOUNT1` through `ZACCOUNT8` have all been seen as the live folder→account foreign key on different systems, and `Z_ENT` values for `ICAccount`/`ICAttachment`/`ICMedia` are not stable). `notesStore.ts`'s `detectSchema()` re-detects these on every cache miss rather than hardcoding any of them — see the comments there before hardcoding a new column name. This was developed and tested against macOS 26 (Tahoe); the detection logic is written to tolerate older versions but hasn't been verified against them.

## Install

```bash
npm install
npm run build
```

## Run

```bash
npm start
```

Or register `dist/index.js` as an MCP server command in your client's configuration.

## Project layout

```
src/
  index.ts        MCP server + tool registrations
  notes.ts        Notes tool implementations (SQLite reads, AppleScript writes)
  notesStore.ts   NoteStore SQLite access + protobuf body decoder
  reminders.ts    Reminders tool implementations + local template/saved-view storage
  applescript.ts  Shared runAppleScript() helper (argv-only, never string-spliced)
  markdown.ts     Markdown -> Notes-compatible HTML converter
swift/
  reminders-daemon.swift  Persistent EventKit daemon (NDJSON over stdio)
scripts/
  test-phase2.mjs           Protobuf/checklist decoder tests (+ pinned full-pipeline fixtures)
  test-markdown.mjs         Markdown -> HTML converter tests
  test-schema-detection.mjs Schema-detection sanity checks against the live DB
dist/             Compiled output (generated by `npm run build`)
```

Reminder templates and saved filter views (`reminders_save_template`, `reminders_save_view`) are stored as JSON under `~/.apple-notes-reminders-mcp/` — there's no server-side database for these, since EventKit has no such concept of its own.

## Notes on permissions and privacy

All reads happen locally against a temporary copy of the local NoteStore database. Nothing is sent off-device by the server itself. The server requires the same access a user already has to their own Notes and Reminders.

## Testing

```bash
npm run build && node scripts/test-phase2.mjs           # protobuf/checklist decoder
npm run build && node scripts/test-markdown.mjs          # markdown -> Notes-HTML converter
npm run build && node scripts/test-schema-detection.mjs  # schema detection sanity (live DB)
```

`test-markdown.mjs` is fully deterministic. `test-phase2.mjs`'s unit-test sections (varint safety, checklist edge cases, pinned full-pipeline fixtures) are self-contained; its final "Real DB notes" section and all of `test-schema-detection.mjs` read the real, live Notes database and will only pass with Full Disk Access and actual note data present — expect failures/errors there on a machine other than the original author's (`test-phase2.mjs`'s DB section specifically references note ids that only exist in that one library).

## Known limitations

- **Folder re-parenting isn't implemented.** Confirmed live that Notes.app's AppleScript `move <folder> to <folder>` is unreliable — it intermittently throws (`item N of every folder kan niet worden opgevraagd`) or silently no-ops, regardless of whether the folder reference comes from `folder id`, a `whose` filter, or a hand-rolled scan. Folder rename and delete are reliable and implemented; re-parenting one folder under another is not, since shipping a tool that fails unpredictably is worse than not having it. Renaming/deleting a *nested* folder (created via the Notes.app UI, not by this server) is supported — pass its full `"Parent/Child"` path.
- **No way to add an attachment via this server.** Reading attachments is fully supported (see above). Adding one requires the Notes.app UI — a Shortcuts-CLI-based bridge was investigated (`shortcuts run <name> -i <path>`) and found not viable as a zero-setup tool: it accepts exactly one input file with no way to also pass a target note, and the `shortcuts` CLI can only run a shortcut that already exists, not create one. See the comment at the top of `notes.ts` for the full writeup.
- **Audio transcripts aren't surfaced.** OCR text from image attachments is (`notes_get`, `notes_search`). The DB also has an audio-transcript-shaped column (`ZTEMPORARYTRANSCRIPTDATA`), but it's an opaque blob and no audio attachments were available to reverse-engineer its format against — left for a future contributor who has real fixture data.
- **A deleted folder can take well over a minute to disappear from `notes_list_folders`.** Confirmed live: the delete itself is instant in Notes.app (and instantly visible to AppleScript), but the SQLite row's soft-delete flag can lag 60s+ behind, seemingly pending an iCloud sync round-trip — much longer than the ~5s SQLite lag typically seen for renames/creates elsewhere. Not something this server can shorten; documented in `notesStore.ts` for anyone chasing what looks like a caching bug.
- **"Smart folders"** (PLAN's original phrasing) don't really exist as a general Notes.app feature the way Reminders has them — the DB's `ZFOLDERTYPE=1` distinguishes only the built-in "Recently Deleted" folder from regular ones. Read-only support for that flag exists (`isSmartFolder` on `notes_list_folders`); tag-based grouping (`notes_list_tags`) is the closer analogue to a "saved smart list" for Notes.
- **Reminders "list sections"** (a newer Reminders.app grouping feature) aren't read — EventKit doesn't expose them, and doing so would mean reverse-engineering Reminders' own separate on-disk store, which wasn't attempted in this pass.

## Tools

### Notes

| Tool | Purpose |
|---|---|
| `notes_list_folders` | List all folders — id, name, nested path, account, smart-folder flag, note count |
| `notes_list` | List notes, optional folder filter, with sort + limit/offset paging |
| `notes_get` | Get a note by name or id, including attachment metadata |
| `notes_get_attachment` | Fetch an image attachment as an MCP image block |
| `notes_get_folder` | Get every note in a folder with decoded bodies in one read, with sort + paging |
| `notes_search` | Search title/body/OCR text across all folders, with sort + paging |
| `notes_create` | Create a note (markdown/html/text body) |
| `notes_update` | Update a note (replace/append/prepend; attachment-safety guard) |
| `notes_delete` | Delete a note |
| `notes_create_folder` | Create a folder |
| `notes_rename_folder` | Rename a folder (top-level or nested, by path) |
| `notes_delete_folder` | Delete a folder (its notes move to Recently Deleted) |
| `notes_move` | Move a note to a different folder |
| `notes_list_tags` | List `#hashtags` used across notes, with note counts |
| `notes_recently_deleted` | List notes in Recently Deleted |
| `notes_restore_note` | Restore a note out of Recently Deleted |
| `notes_query_where` | Count/list notes matching a word-based filter (folder, search, tag) |
| `notes_delete_where` | Bulk-delete matching notes (confirm-gated) |
| `notes_move_where` | Bulk-move matching notes (confirm-gated) |

### Reminders

| Tool | Purpose |
|---|---|
| `reminders_list_lists` | List all reminder lists |
| `reminders_list` | List reminders, optional list filter, with sort + limit/offset paging |
| `reminders_get` | Get a reminder by name or id |
| `reminders_search` | Search reminders by name/notes/list |
| `reminders_view` | Reminders.app-style smart lists: today/planned/overdue/urgent/flagged/completed |
| `reminders_create` | Create a reminder (natural-language due date, flag, recurrence, early/location alarms) |
| `reminders_create_batch` | Create many reminders in one native call (single DB commit) |
| `reminders_update` | Update a reminder |
| `reminders_complete` | Mark completed/incomplete |
| `reminders_delete` | Delete a reminder |
| `reminders_create_list` | Create a list |
| `reminders_rename_list` | Rename a list |
| `reminders_delete_list` | Delete a list and its reminders |
| `reminders_add_subtask` | Add a subtask (AppleScript — EventKit has no public subtask API) |
| `reminders_complete_subtask` | Complete/restore a subtask |
| `reminders_delete_completed` | Bulk-delete completed reminders, optionally scoped to a list |
| `reminders_query_where` | Count/list reminders matching a word-based filter |
| `reminders_delete_where` | Bulk-delete matching reminders (confirm-gated) |
| `reminders_complete_where` | Bulk-complete/incomplete matching reminders (confirm-gated) |
| `reminders_move_where` | Bulk-move matching reminders to another list (confirm-gated) |
| `reminders_save_template` | Save a named reminder template |
| `reminders_list_templates` | List saved templates |
| `reminders_delete_template` | Delete a saved template |
| `reminders_create_from_template` | Create a reminder from a template, with per-call overrides |
| `reminders_save_view` | Save a named word-based filter as a reusable view |
| `reminders_list_views` | List saved views |
| `reminders_delete_view` | Delete a saved view |
| `reminders_run_view` | Run a saved view and return matching reminders |
