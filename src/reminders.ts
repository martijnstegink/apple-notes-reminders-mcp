import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import * as chrono from "chrono-node";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import path from "path";

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
}

export interface ReminderList {
  id: string;
  name: string;
}

// ─── Natural language date parsing ───────────────────────────────────────────

export function parseNaturalDate(input: string): Date | null {
  return chrono.nl.parseDate(input) ?? chrono.parseDate(input) ?? null;
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

// ─── Reminder operations ──────────────────────────────────────────────────────

export async function listReminders(options: {
  listName?: string;
  includeCompleted?: boolean;
}): Promise<Reminder[]> {
  return call("list-reminders", {
    listName: options.listName,
    includeCompleted: options.includeCompleted ?? false,
  }) as Promise<Reminder[]>;
}

export async function getReminder(identifier: string): Promise<Reminder | null> {
  try {
    return (await call("get-reminder", { identifier })) as Reminder;
  } catch {
    return null;
  }
}

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
  return ((await call("create-reminder", params)) as { id: string }).id;
}

export async function createRemindersBatch(
  items: Array<{ name: string; body?: string; listName?: string; dueDateInput?: string; priority?: number; url?: string }>
): Promise<{ created: number; failed: number; errors: Array<{ index: number; name: string; error: string }> }> {
  let created = 0;
  let failed = 0;
  const errors: Array<{ index: number; name: string; error: string }> = [];
  for (let i = 0; i < items.length; i++) {
    try {
      await createReminder(items[i]);
      created++;
    } catch (err) {
      failed++;
      errors.push({ index: i, name: items[i].name, error: String(err) });
    }
  }
  return { created, failed, errors };
}

export async function updateReminder(
  identifier: string,
  updates: { name?: string; body?: string; dueDateInput?: string; priority?: number; url?: string; listName?: string }
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
  await call("update-reminder", params);
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
  hasDueDate?: boolean;
}

// Translates a word-based filter into daemon params, parsing natural-language
// dates to ISO here (chrono lives in Node, not in the Swift helper).
function buildFilterParams(f: ReminderFilter): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (f.list) p.listName = f.list;
  if (f.completed !== undefined) p.completed = f.completed;
  if (f.search) p.search = f.search;
  if (f.priority !== undefined) p.priority = f.priority;
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

export async function queryRemindersWhere(
  filter: ReminderFilter,
  countOnly: boolean
): Promise<Reminder[] | { count: number }> {
  return call("query-where", { ...buildFilterParams(filter), countOnly }) as Promise<
    Reminder[] | { count: number }
  >;
}

// Without confirm: returns { count, confirmed: false } and changes nothing.
// With confirm: performs the deletion and returns counts.
export async function deleteRemindersWhere(
  filter: ReminderFilter,
  confirm: boolean
): Promise<{ count: number; confirmed: false } | { deleted: number; failed: number; total: number; confirmed: true }> {
  return call("delete-where", { ...buildFilterParams(filter), confirm }) as Promise<any>;
}

export async function completeRemindersWhere(
  filter: ReminderFilter,
  setCompleted: boolean,
  confirm: boolean
): Promise<{ count: number; confirmed: false } | { updated: number; failed: number; total: number; confirmed: true }> {
  return call("complete-where", { ...buildFilterParams(filter), setCompleted, confirm }) as Promise<any>;
}

export async function moveRemindersWhere(
  filter: ReminderFilter,
  destinationList: string,
  confirm: boolean
): Promise<{ count: number; confirmed: false } | { moved: number; failed: number; total: number; confirmed: true }> {
  return call("move-where", { ...buildFilterParams(filter), destinationList, confirm }) as Promise<any>;
}

// ─── Subtasks (AppleScript — EventKit public API does not expose subtasks) ────

import { runAppleScript } from "./applescript.js";

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
