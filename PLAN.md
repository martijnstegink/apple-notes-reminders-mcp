# Improvement Plan — apple-notes-reminders-mcp

MCP server for Apple Notes & Reminders. Architecture: SQLite reads
(NoteStore.sqlite + protobuf body decoder), AppleScript writes for Notes,
Swift EventKit daemon (NDJSON over stdio) for Reminders.

## Working rules
- Work ONE phase at a time. Build (`npm run build`) and test after every
  change. Commit when the phase is done, then stop and summarize.
- Live tests: create a fresh Notes folder and Reminders list per test run,
  with a unique name (e.g. "MCP-Test-<timestamp>") — never a shared/
  persistent "MCP-Test" list/folder reused across runs, since that's what
  produced a pile of duplicate empty Reminders lists over time. Never
  modify or delete anything else. Delete the run's folder and list
  completely at the end, in a finally/afterAll, even if the run fails.
- Never string-splice user content into AppleScript. Pass via argv.

## Phase 1 — Reliability foundation
1. Pass all AppleScript content via `osascript ... on run argv`
   (kills quote/backslash/Unicode escaping bugs in esc()).
2. Replace execFileSync with async execFile + timeouts on every
   AppleScript call (runAS currently has no timeout).
3. Add per-call timeouts to daemon IPC in src/reminders.ts; auto-restart
   daemon with backoff; reject pending calls on timeout.
4. Fix asFind() in src/notes.ts: detect IDs by "x-coredata://" prefix,
   not `includes(":")` (note titles with colons misroute).
5. Add zod as a direct dependency in package.json.
6. Remove dead code: vestigial `skipped` counters, swift/reminders-helper.swift.
7. Compile swift/reminders-daemon.swift in a postinstall/build script
   instead of committing the binary.

## Phase 2 — Markdown writes (formatted notes)
1. New module: Markdown → Notes-compatible HTML. Support: # ## ### →
   h1/h2/h3, **bold**/*italic*, - lists → ul, 1. lists → ol, [text](url),
   paragraphs → <div>, blank line → <div><br></div>, inline `code` → tt.
   Degrade gracefully: "- [ ]" → dash list, tables → text. #tags pass
   through as plain text (Notes auto-links them).
2. notes_create / notes_update: add format param "markdown" (default) |
   "html" | "text". Auto-prepend <h1>{name}</h1> so title is stable.
3. notes_update: add mode param "replace" | "append" | "prepend".
   Guard: if the target note has attachments and mode=replace, return a
   warning instead of silently destroying them (require force=true).
4. Round-trip tests: write markdown → read via notes_get → verify
   structure survives.

## Phase 3 — Reminders power features
1. Flagged support via AppleScript (EventKit doesn't expose it):
   read + write + add `flagged` to filters and reminder output.
2. New tool reminders_view: today | planned | overdue | urgent |
   flagged | completed (urgent = priority 1-4). Add priority_at_most /
   priority range to filters.
3. Recurrence via EKRecurrenceRule (daily/weekly/monthly/yearly +
   interval); early reminders via relative EKAlarm; location-based
   alarms via EKAlarm structuredLocation (params: lat/lon/radius/
   arrive|leave).
4. reminders_rename_list. Native create-batch command in the Swift
   daemon (currently N round-trips from Node).

## Phase 4 — Notes folders & organization
1. Folder rename, delete, re-parent. Model nesting: folders get a
   `path` (e.g. "Recipes/Desserts"); disambiguate same-named folders.
2. Account awareness (iCloud vs On My Mac) in folder listing.
3. Read-only from DB: pinned status, tags, smart folders (list + their
   contents), Recently Deleted listing + restore (move out via AppleScript).

## Phase 5 — Images & attachments
1. Read attachments from the DB (ZICATTACHMENT/ZMEDIA) and Group
   Container media files; notes_get returns real attachment metadata;
   new tool notes_get_attachment returns image content as MCP image block.
2. Surface OCR text (scanned docs/images) and audio transcripts stored
   in the DB in notes_get/search.
3. Research spike: adding images to notes via Shortcuts CLI bridge
   (`shortcuts run`). Document findings; implement if viable.

## Phase 6 — Performance & polish
1. Cache DB connection + detectSchema result; invalidate on file mtime.
   In-memory decoded-body cache keyed on Z_PK + modification date.
2. Pagination (limit/offset) + sort (default: modified desc) on
   notes_list, notes_get_folder, notes_search, reminders_list.
3. Server-side emulation: reminders_save_template /
   reminders_create_from_template (JSON stored locally); saved smart
   lists (named filter presets). Read-only list sections from Reminders DB.
4. Test suite: pinned protobuf fixture blobs for the decoder, schema-
   detection tests, markdown converter tests. Update README (tools table,
   permissions, macOS version notes).
