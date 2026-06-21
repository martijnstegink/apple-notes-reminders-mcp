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
};

let daemon: ChildProcess | null = null;
let daemonReadyPromise: Promise<void> | null = null;
let daemonReadyResolve: (() => void) | null = null;
const pending = new Map<string, PendingCall>();
let buf = "";

function ensureDaemon(): Promise<void> {
  if (daemon && !daemon.killed && daemonReadyPromise) return daemonReadyPromise;

  daemonReadyPromise = new Promise<void>((res) => { daemonReadyResolve = res; });
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
        daemonReadyResolve?.();
        continue;
      }

      const id = msg.id as string | undefined;
      if (!id) continue;
      const call = pending.get(id);
      if (!call) continue;

      // Single request/response per call
      pending.delete(id);
      if ("error" in msg) {
        call.reject(new Error(String(msg.error)));
      } else {
        call.resolve(msg.result);
      }
    }
  });

  daemon.on("exit", () => {
    daemon = null;
    daemonReadyPromise = null;
    // Reject all pending calls
    for (const [id, call] of pending) {
      call.reject(new Error("Daemon exited"));
      pending.delete(id);
    }
  });

  return daemonReadyPromise;
}

async function call(command: string, params?: Record<string, unknown>): Promise<unknown> {
  await ensureDaemon();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
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

import { execFileSync } from "child_process";

function runAS(script: string): string {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

function findScript(id: string): string {
  const e = id.replace(/"/g, '\\"');
  return `set t to missing value
repeat with l in lists
  repeat with r in reminders of l
    if id of r is "${e}" or name of r is "${e}" then
      set t to r
      exit repeat
    end if
  end repeat
  if t is not missing value then exit repeat
end repeat
if t is missing value then error "Not found: ${e}"`;
}

export async function addSubtask(parentId: string, subtaskName: string): Promise<string> {
  return runAS(`tell application "Reminders"
${findScript(parentId)}
set s to make new subtask at t with properties {name:"${subtaskName.replace(/"/g, '\\"')}"}
return id of s
end tell`);
}

export async function completeSubtask(parentId: string, subtaskId: string, completed: boolean): Promise<void> {
  const e = subtaskId.replace(/"/g, '\\"');
  runAS(`tell application "Reminders"
${findScript(parentId)}
repeat with s in subtasks of t
  if id of s is "${e}" or name of s is "${e}" then
    set completed of s to ${completed}
    exit repeat
  end if
end repeat
end tell`);
}
