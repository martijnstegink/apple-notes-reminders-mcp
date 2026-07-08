import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import * as chrono from "chrono-node";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import path from "path";
import { runAppleScript } from "./applescript.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_BIN = path.join(__dirname, "..", "swift", "reminders-daemon");

// ─── Persistent daemon IPC ────────────────────────────────────────────────────

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

const CALL_TIMEOUT_MS = 30_000;
const BASE_RESTART_BACKOFF_MS = 500;
const MAX_RESTART_BACKOFF_MS = 10_000;

let daemon: ChildProcess | null = null;
let daemonReadyPromise: Promise<void> | null = null;
let daemonReadyResolve: (() => void) | null = null;
let daemonReadyReject: ((err: Error) => void) | null = null;
let spawnScheduled = false;
let consecutiveFailedSpawns = 0;
let nextSpawnAllowedAt = 0;
const pending = new Map<string, PendingCall>();
let buf = "";

function spawnDaemon(): void {
  spawnScheduled = false;
  let sawReady = false;

  daemon = spawn(DAEMON_BIN, [], { stdio: ["pipe", "pipe", "inherit"] });

  daemon.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const raw of lines) {
      if (!raw.trim()) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw); } catch { continue; }

      // Startup signal
      if (msg.ready === true) {
        sawReady = true;
        consecutiveFailedSpawns = 0;
        daemonReadyResolve?.();
        continue;
      }

      const id = msg.id as string | undefined;
      if (!id) continue;
      const pendingCall = pending.get(id);
      if (!pendingCall) continue;

      // Single request/response per call
      pending.delete(id);
      clearTimeout(pendingCall.timeout);
      if ("error" in msg) {
        pendingCall.reject(new Error(String(msg.error)));
      } else {
        pendingCall.resolve(msg.result);
      }
    }
  });

  daemon.on("exit", () => {
    daemon = null;
    daemonReadyPromise = null;
    if (!sawReady) {
      consecutiveFailedSpawns++;
      nextSpawnAllowedAt =
        Date.now() + Math.min(BASE_RESTART_BACKOFF_MS * 2 ** (consecutiveFailedSpawns - 1), MAX_RESTART_BACKOFF_MS);
    }
    const err = new Error("Daemon exited");
    daemonReadyReject?.(err);
    // Reject all pending calls
    for (const [id, pendingCall] of pending) {
      clearTimeout(pendingCall.timeout);
      pendingCall.reject(err);
      pending.delete(id);
    }
  });
}

function ensureDaemon(): Promise<void> {
  if (daemon && !daemon.killed && daemonReadyPromise) return daemonReadyPromise;
  if (spawnScheduled && daemonReadyPromise) return daemonReadyPromise;

  daemonReadyPromise = new Promise<void>((res, rej) => {
    daemonReadyResolve = res;
    daemonReadyReject = rej;
  });

  const wait = Math.max(0, nextSpawnAllowedAt - Date.now());
  spawnScheduled = true;
  if (wait > 0) setTimeout(spawnDaemon, wait);
  else spawnDaemon();

  return daemonReadyPromise;
}

async function call(command: string, params?: Record<string, unknown>): Promise<unknown> {
  await ensureDaemon();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Reminders daemon call "${command}" timed out after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timeout });
    const msg = JSON.stringify({ id, command, params: params ?? {} }) + "\n";
    daemon!.stdin!.write(msg);
  });
}


// ─── Types ────────────────────────────────────────────────────────────────────

export interface Reminder {
  id: string;
  name: string;
  body: string;
  list: string;
  dueDate: string;
  completionDate: string;
  isCompleted: boolean;
  priority: number;
  url: string;
  flagged?: boolean;
  isRecurring?: boolean;
  recurrence?: { frequency: string; interval: number };
}

export interface RecurrenceInput {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  count?: number;
  until?: string;
}

export interface LocationAlarmInput {
  latitude: number;
  longitude: number;
  radius?: number;
  proximity?: "arrive" | "leave";
  title?: string;
}

export interface ReminderList {
  id: string;
  name: string;
}

// ─── Natural language date parsing ───────────────────────────────────────────

export function parseNaturalDate(input: string): Date | null {
  return chrono.nl.parseDate(input) ?? chrono.parseDate(input) ?? null;
}

// ─── Flagged (AppleScript — EventKit's public API has no "flagged" property) ──
// Flagged state is read/written entirely via AppleScript and merged into
// EventKit-sourced Reminder objects by id.

const FLAGGED_FULL_SCAN_TIMEOUT_MS = 90_000; // scanning every list is slow — see SUBTASK_TIMEOUT_MS below

function normalizeReminderId(id: string): string {
  return id.startsWith("x-apple-reminder://") ? id.slice("x-apple-reminder://".length) : id;
}

// Returns the set of flagged reminder ids, scoped to one list when given (fast)
// or scanning every list when omitted (bounded by FLAGGED_FULL_SCAN_TIMEOUT_MS).
async function fetchFlaggedIds(listName?: string): Promise<Set<string>> {
  const raw = await runAppleScript(
    `on run argv
tell application "Reminders"
set out to ""
set targetLists to {}
if (item 1 of argv) is not "" then
  set targetLists to {list (item 1 of argv)}
else
  set targetLists to lists
end if
repeat with l in targetLists
  repeat with r in reminders of l
    if flagged of r then set out to out & (id of r) & linefeed
  end repeat
end repeat
return out
end tell
end run`,
    [listName ?? ""],
    listName ? undefined : FLAGGED_FULL_SCAN_TIMEOUT_MS
  );
  return new Set(raw.split("\n").map((s) => s.trim()).filter(Boolean).map(normalizeReminderId));
}

async function mergeFlagged<T extends Reminder>(reminders: T[], listName?: string): Promise<T[]> {
  if (reminders.length === 0) return reminders;
  const flaggedIds = await fetchFlaggedIds(listName);
  return reminders.map((r) => ({ ...r, flagged: flaggedIds.has(normalizeReminderId(r.id)) }));
}

export async function setReminderFlagged(identifier: string, flagged: boolean): Promise<void> {
  await runAppleScript(
    `on run argv
tell application "Reminders"
${findScriptExpr(1)}
set flagged of t to ((item 2 of argv) is "true")
end tell
end run`,
    [identifier, String(flagged)],
    SUBTASK_TIMEOUT_MS
  );
}

// ─── List operations ──────────────────────────────────────────────────────────

export async function listReminderLists(): Promise<ReminderList[]> {
  return call("list-lists") as Promise<ReminderList[]>;
}

export async function createReminderList(name: string): Promise<string> {
  return ((await call("create-list", { name })) as { id: string }).id;
}

export async function deleteReminderList(name: string): Promise<void> {
  await call("delete-list", { name });
}

export async function renameReminderList(name: string, newName: string): Promise<void> {
  await call("rename-list", { name, newName });
}

// ─── Reminder operations ──────────────────────────────────────────────────────

// Flagged is merged in only when the AppleScript scan can be scoped to a single
// list (fast, ~1 list worth of reminders). An unscoped whole-library scan measured
// well over 90s on a real library (380 reminders across 20 lists — AppleScript's
// per-property IPC overhead dominates), so listReminders/searchReminders across
// *all* lists intentionally omit `flagged` rather than pay that tax on every call.
export async function listReminders(options: {
  listName?: string;
  includeCompleted?: boolean;
}): Promise<Reminder[]> {
  const r = (await call("list-reminders", {
    listName: options.listName,
    includeCompleted: options.includeCompleted ?? false,
  })) as Reminder[];
  return options.listName ? mergeFlagged(r, options.listName) : r;
}

export async function getReminder(identifier: string): Promise<Reminder | null> {
  try {
    const r = (await call("get-reminder", { identifier })) as Reminder;
    return (await mergeFlagged([r], r.list))[0];
  } catch {
    return null;
  }
}

// Searches across all lists by design, so flagged status is intentionally omitted
// (see comment above) — use reminders_query_where / reminders_view with a `list`
// or `flagged` filter when flagged status is needed.
export async function searchReminders(query: string): Promise<Reminder[]> {
  return call("search-reminders", { query }) as Promise<Reminder[]>;
}

export async function createReminder(options: {
  name: string;
  body?: string;
  listName?: string;
  dueDateInput?: string;
  priority?: number;
  url?: string;
  flagged?: boolean;
  recurrence?: RecurrenceInput;
  earlyAlarmMinutes?: number[];
  locationAlarm?: LocationAlarmInput;
}): Promise<string> {
  const params: Record<string, unknown> = { name: options.name };
  if (options.body) params.body = options.body;
  if (options.listName) params.listName = options.listName;
  if (options.priority !== undefined) params.priority = options.priority;
  if (options.url) params.url = options.url;
  if (options.dueDateInput) {
    const parsed = parseNaturalDate(options.dueDateInput);
    if (parsed) params.dueDate = parsed.toISOString();
  }
  if (options.earlyAlarmMinutes) params.earlyAlarmMinutes = options.earlyAlarmMinutes;
  if (options.recurrence) params.recurrence = options.recurrence;
  if (options.locationAlarm) params.locationAlarm = options.locationAlarm;
  const id = ((await call("create-reminder", params)) as { id: string }).id;
  if (options.flagged) await setReminderFlagged(id, true);
  return id;
}

export async function createRemindersBatch(
  items: Array<{ name: string; body?: string; dueDateInput?: string; priority?: number; url?: string }>,
  listName?: string
): Promise<{ created: number; failed: number; errors: Array<{ index: number; name: string; error: string }> }> {
  const payload = items.map((item) => {
    const p: Record<string, unknown> = { name: item.name };
    if (item.body) p.body = item.body;
    if (item.priority !== undefined) p.priority = item.priority;
    if (item.url) p.url = item.url;
    if (item.dueDateInput) {
      const parsed = parseNaturalDate(item.dueDateInput);
      if (parsed) p.dueDate = parsed.toISOString();
    }
    return p;
  });
  const params: Record<string, unknown> = { items: payload };
  if (listName) params.listName = listName;
  return call("create-batch", params) as Promise<{
    created: number;
    failed: number;
    errors: Array<{ index: number; name: string; error: string }>;
  }>;
}

export async function updateReminder(
  identifier: string,
  updates: {
    name?: string;
    body?: string;
    dueDateInput?: string;
    priority?: number;
    url?: string;
    listName?: string;
    flagged?: boolean;
    recurrence?: RecurrenceInput | "none";
    earlyAlarmMinutes?: number[];
    locationAlarm?: LocationAlarmInput;
  }
): Promise<void> {
  const params: Record<string, unknown> = { identifier };
  if (updates.name !== undefined) params.name = updates.name;
  if (updates.body !== undefined) params.body = updates.body;
  if (updates.priority !== undefined) params.priority = updates.priority;
  if (updates.url !== undefined) params.url = updates.url;
  if (updates.listName !== undefined) params.listName = updates.listName;
  if (updates.dueDateInput) {
    if (updates.dueDateInput === "none" || updates.dueDateInput === "remove") {
      params.dueDate = "none";
    } else {
      const parsed = parseNaturalDate(updates.dueDateInput);
      if (parsed) params.dueDate = parsed.toISOString();
    }
  }
  if (updates.earlyAlarmMinutes) params.earlyAlarmMinutes = updates.earlyAlarmMinutes;
  if (updates.recurrence !== undefined) params.recurrence = updates.recurrence;
  if (updates.locationAlarm) params.locationAlarm = updates.locationAlarm;
  await call("update-reminder", params);
  if (updates.flagged !== undefined) await setReminderFlagged(identifier, updates.flagged);
}

export async function completeReminder(identifier: string, completed: boolean): Promise<void> {
  await call("complete-reminder", { identifier, completed });
}

export async function deleteReminder(identifier: string): Promise<void> {
  await call("delete-reminder", { identifier });
}

export async function deleteCompletedReminders(
  listName?: string
): Promise<{ deleted: number; failed: number; total: number }> {
  const params: Record<string, unknown> = {};
  if (listName) params.listName = listName;
  return call("delete-completed", params) as Promise<{ deleted: number; failed: number; total: number }>;
}

// ─── Filter-based bulk operations ─────────────────────────────────────────────
// Describe which reminders to act on in words; the server fetches, filters, and
// acts natively. The caller never sees or passes individual IDs.

export interface ReminderFilter {
  list?: string;
  completed?: boolean;
  search?: string;
  dueBefore?: string; // natural language, e.g. "today", "next Friday"
  dueAfter?: string; // natural language
  priority?: number;
  priorityAtMost?: number;
  priorityAtLeast?: number;
  hasDueDate?: boolean;
  flagged?: boolean; // not known to the daemon (EventKit has no flagged property) — resolved via AppleScript
}

// Translates a word-based filter into daemon params, parsing natural-language
// dates to ISO here (chrono lives in Node, not in the Swift helper). `flagged`
// is deliberately excluded — the daemon (EventKit) has no concept of it.
function buildFilterParams(f: ReminderFilter): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (f.list) p.listName = f.list;
  if (f.completed !== undefined) p.completed = f.completed;
  if (f.search) p.search = f.search;
  if (f.priority !== undefined) p.priority = f.priority;
  if (f.priorityAtMost !== undefined) p.priorityAtMost = f.priorityAtMost;
  if (f.priorityAtLeast !== undefined) p.priorityAtLeast = f.priorityAtLeast;
  if (f.hasDueDate !== undefined) p.hasDueDate = f.hasDueDate;
  if (f.dueBefore) {
    const d = parseNaturalDate(f.dueBefore);
    if (d) p.dueBefore = d.toISOString();
  }
  if (f.dueAfter) {
    const d = parseNaturalDate(f.dueAfter);
    if (d) p.dueAfter = d.toISOString();
  }
  return p;
}

// Resolves a filter to the actual matching reminders, merging + filtering by
// `flagged` in Node when the filter needs it (the daemon can't do it natively).
async function resolveMatches(filter: ReminderFilter): Promise<Reminder[]> {
  const matches = (await call("query-where", { ...buildFilterParams(filter), countOnly: false })) as Reminder[];
  if (filter.flagged === undefined) return matches;
  const merged = await mergeFlagged(matches, filter.list);
  return merged.filter((r) => r.flagged === filter.flagged);
}

export async function queryRemindersWhere(
  filter: ReminderFilter,
  countOnly: boolean
): Promise<Reminder[] | { count: number }> {
  if (filter.flagged === undefined) {
    return call("query-where", { ...buildFilterParams(filter), countOnly }) as Promise<
      Reminder[] | { count: number }
    >;
  }
  const matches = await resolveMatches(filter);
  return countOnly ? { count: matches.length } : matches;
}

// Without confirm: returns { count, confirmed: false } and changes nothing.
// With confirm: performs the deletion and returns counts.
export async function deleteRemindersWhere(
  filter: ReminderFilter,
  confirm: boolean
): Promise<{ count: number; confirmed: false } | { deleted: number; failed: number; total: number; confirmed: true }> {
  if (filter.flagged === undefined) {
    return call("delete-where", { ...buildFilterParams(filter), confirm }) as Promise<any>;
  }
  const matches = await resolveMatches(filter);
  if (!confirm) return { count: matches.length, confirmed: false };
  let deleted = 0, failed = 0;
  for (const r of matches) {
    try { await deleteReminder(r.id); deleted++; } catch { failed++; }
  }
  return { deleted, failed, total: matches.length, confirmed: true };
}

export async function completeRemindersWhere(
  filter: ReminderFilter,
  setCompleted: boolean,
  confirm: boolean
): Promise<{ count: number; confirmed: false } | { updated: number; failed: number; total: number; confirmed: true }> {
  if (filter.flagged === undefined) {
    return call("complete-where", { ...buildFilterParams(filter), setCompleted, confirm }) as Promise<any>;
  }
  const matches = await resolveMatches(filter);
  if (!confirm) return { count: matches.length, confirmed: false };
  let updated = 0, failed = 0;
  for (const r of matches) {
    try { await completeReminder(r.id, setCompleted); updated++; } catch { failed++; }
  }
  return { updated, failed, total: matches.length, confirmed: true };
}

export async function moveRemindersWhere(
  filter: ReminderFilter,
  destinationList: string,
  confirm: boolean
): Promise<{ count: number; confirmed: false } | { moved: number; failed: number; total: number; confirmed: true }> {
  if (filter.flagged === undefined) {
    return call("move-where", { ...buildFilterParams(filter), destinationList, confirm }) as Promise<any>;
  }
  const matches = await resolveMatches(filter);
  if (!confirm) return { count: matches.length, confirmed: false };
  let moved = 0, failed = 0;
  for (const r of matches) {
    try { await updateReminder(r.id, { listName: destinationList }); moved++; } catch { failed++; }
  }
  return { moved, failed, total: matches.length, confirmed: true };
}

// ─── Views (Reminders.app-style smart lists) ──────────────────────────────────

export type ReminderView = "today" | "planned" | "overdue" | "urgent" | "flagged" | "completed";

export async function viewReminders(view: ReminderView, listName?: string): Promise<Reminder[]> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const filter: ReminderFilter = { list: listName };
  switch (view) {
    case "today":
      filter.completed = false;
      filter.dueBefore = new Date(endOfToday.getTime() + 1).toISOString();
      filter.dueAfter = new Date(startOfToday.getTime() - 1).toISOString();
      break;
    case "planned":
      filter.completed = false;
      filter.dueAfter = endOfToday.toISOString();
      break;
    case "overdue":
      filter.completed = false;
      filter.dueBefore = startOfToday.toISOString();
      break;
    case "urgent":
      filter.completed = false;
      filter.priorityAtLeast = 1;
      filter.priorityAtMost = 4;
      break;
    case "flagged":
      filter.completed = false;
      filter.flagged = true;
      break;
    case "completed":
      filter.completed = true;
      break;
  }

  // dueBefore/dueAfter above are already ISO strings; buildFilterParams would
  // re-parse them with chrono if we routed through queryRemindersWhere's
  // natural-language path, so call the daemon/merge logic directly instead.
  const params: Record<string, unknown> = { countOnly: false };
  if (filter.list) params.listName = filter.list;
  if (filter.completed !== undefined) params.completed = filter.completed;
  if (filter.priorityAtLeast !== undefined) params.priorityAtLeast = filter.priorityAtLeast;
  if (filter.priorityAtMost !== undefined) params.priorityAtMost = filter.priorityAtMost;
  if (filter.dueBefore) params.dueBefore = filter.dueBefore;
  if (filter.dueAfter) params.dueAfter = filter.dueAfter;

  const matches = (await call("query-where", params)) as Reminder[];
  if (filter.flagged === undefined) return matches;
  const merged = await mergeFlagged(matches, filter.list);
  return merged.filter((r) => r.flagged === filter.flagged);
}

// ─── Subtasks (AppleScript — EventKit public API does not expose subtasks) ────

// Finds the parent reminder by id or name, read from argv[argIndex]; never
// splice the identifier into the script text.
// EventKit's calendarItemIdentifier (the id used everywhere else in this codebase)
// is a bare UUID, but AppleScript's own `id of r` returns "x-apple-reminder://<uuid>" —
// so match both the bare and prefixed forms, not just an exact string compare.
function findScriptExpr(argIndex: number): string {
  return `set t to missing value
repeat with l in lists
  repeat with r in reminders of l
    if id of r is (item ${argIndex} of argv) or id of r is ("x-apple-reminder://" & (item ${argIndex} of argv)) or name of r is (item ${argIndex} of argv) then
      set t to r
      exit repeat
    end if
  end repeat
  if t is not missing value then exit repeat
end repeat
if t is missing value then error "Not found: " & (item ${argIndex} of argv)`;
}

// findScriptExpr brute-force scans every reminder in every list via AppleScript,
// which measured ~20s on a real library — comfortably past the 30s default, so
// these two calls get a longer timeout.
const SUBTASK_TIMEOUT_MS = 90_000;

export async function addSubtask(parentId: string, subtaskName: string): Promise<string> {
  return runAppleScript(
    `on run argv
tell application "Reminders"
${findScriptExpr(1)}
set s to make new subtask at t with properties {name:(item 2 of argv)}
return id of s
end tell
end run`,
    [parentId, subtaskName],
    SUBTASK_TIMEOUT_MS
  );
}

export async function completeSubtask(parentId: string, subtaskId: string, completed: boolean): Promise<void> {
  await runAppleScript(
    `on run argv
tell application "Reminders"
${findScriptExpr(1)}
repeat with s in subtasks of t
  if id of s is (item 2 of argv) or name of s is (item 2 of argv) then
    set completed of s to ((item 3 of argv) is "true")
    exit repeat
  end if
end repeat
end tell
end run`,
    [parentId, subtaskId, String(completed)],
    SUBTASK_TIMEOUT_MS
  );
}
