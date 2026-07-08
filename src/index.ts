import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as Notes from "./notes.js";
import * as Reminders from "./reminders.js";

const server = new McpServer({ name: "apple-notes-reminders-mcp", version: "1.0.0" });

// ─── Notes ────────────────────────────────────────────────────────────

server.tool("notes_list_folders", "List all folders in Apple Notes", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify(await Notes.listFolders(), null, 2) }],
}));

server.tool(
  "notes_list",
  "List notes, optionally filtered by folder",
  { folder: z.string().optional().describe("Folder name to filter by") },
  async ({ folder }) => {
    const { results, skipped } = await Notes.listNotes(folder);
    const text = results.length ? JSON.stringify(results, null, 2) : "No notes found.";
    const warn = skipped > 0 ? `\n[${skipped} note(s) skipped — could not read their properties]` : "";
    return { content: [{ type: "text", text: text + warn }] };
  }
);

server.tool(
  "notes_get",
  "Get a note by name or ID",
  { identifier: z.string().describe("Note name or ID") },
  async ({ identifier }) => {
    const note = await Notes.getNote(identifier);
    return note
      ? { content: [{ type: "text", text: JSON.stringify(note, null, 2) }] }
      : { content: [{ type: "text", text: `Note not found: ${identifier}` }], isError: true };
  }
);

server.tool(
  "notes_get_folder",
  "Get every note in a folder with its decoded body, in a single database read. " +
  "Use this instead of looping notes_get when you need to summarize, search, or process all notes in a folder — " +
  "one call replaces N separate notes_get calls. " +
  "Checklist items render as - [x] / - [ ]. " +
  "Optional max_chars truncates large bodies; truncated notes carry truncated=true so you can fetch the full body with notes_get.",
  {
    folder: z.string().optional().describe("Folder name. Omit to return all notes from every folder."),
    max_chars: z.number().int().positive().optional().describe(
      "Max body characters per note. Bodies longer than this are truncated and marked truncated=true."
    ),
  },
  async ({ folder, max_chars }) => {
    const results = await Notes.getFolderWithBodies(folder, max_chars);
    const text = results.length
      ? JSON.stringify(results, null, 2)
      : folder ? `No notes found in folder "${folder}".` : "No notes found.";
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "notes_search",
  "Search notes by title or content across all folders. " +
  "Use with_body: true to include the decoded body of each matching note " +
  "(checklist items render as - [x] / - [ ], same encoding as notes_get). " +
  "Prefer notes_get_folder when the folder is known and you want all its notes; " +
  "use notes_search for cross-folder queries or when the folder is unknown. " +
  "Optional max_chars truncates large bodies (default 300 when with_body=true); " +
  "truncated notes carry truncated=true so you can fetch the full body with notes_get.",
  {
    query: z.string().describe("Search query"),
    with_body: z.boolean().optional().describe(
      "Include the decoded body in each result (default false). Truncated to max_chars."
    ),
    max_chars: z.number().int().positive().optional().describe(
      "Max body characters per result when with_body=true (default 300). " +
      "Bodies longer than this are truncated and marked truncated=true."
    ),
  },
  async ({ query, with_body, max_chars }) => {
    const { results, skipped } = await Notes.searchNotes(query, with_body ?? false, max_chars);
    const text = results.length ? JSON.stringify(results, null, 2) : "No results.";
    const warn = skipped > 0 ? `\n[${skipped} note(s) skipped — could not read their properties]` : "";
    return { content: [{ type: "text", text: text + warn }] };
  }
);

server.tool(
  "notes_create",
  "Create a new note",
  {
    name: z.string().describe("Title"),
    body: z.string().describe("Body content (HTML or plain text)"),
    folder: z.string().optional().describe("Folder name"),
  },
  async ({ name, body, folder }) => ({
    content: [{ type: "text", text: `Note created: ${await Notes.createNote(name, body, folder)}` }],
  })
);

server.tool(
  "notes_update",
  "Update an existing note",
  {
    identifier: z.string().describe("Note name or ID"),
    name: z.string().optional().describe("New title"),
    body: z.string().optional().describe("New body content"),
    folder: z.string().optional().describe("Move to folder"),
  },
  async ({ identifier, name, body, folder }) => {
    await Notes.updateNote(identifier, { name, body, folderName: folder });
    return { content: [{ type: "text", text: "Note updated." }] };
  }
);

server.tool(
  "notes_delete",
  "Delete a note",
  { identifier: z.string().describe("Note name or ID") },
  async ({ identifier }) => {
    await Notes.deleteNote(identifier);
    return { content: [{ type: "text", text: "Note deleted." }] };
  }
);

server.tool(
  "notes_create_folder",
  "Create a new folder in Apple Notes",
  { name: z.string().describe("Folder name") },
  async ({ name }) => ({
    content: [{ type: "text", text: `Folder created: ${await Notes.createFolder(name)}` }],
  })
);

server.tool(
  "notes_move",
  "Move a note to a different folder",
  { identifier: z.string().describe("Note name or ID"), folder: z.string().describe("Destination folder") },
  async ({ identifier, folder }) => {
    await Notes.moveNote(identifier, folder);
    return { content: [{ type: "text", text: "Note moved." }] };
  }
);

// ─── Reminders (EventKit) ─────────────────────────────────────────────

server.tool("reminders_list_lists", "List all reminder lists", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify(await Reminders.listReminderLists(), null, 2) }],
}));

server.tool(
  "reminders_list",
  "List reminders, optionally filtered by list",
  {
    list: z.string().optional().describe("List name to filter by"),
    include_completed: z.boolean().optional().describe("Include completed reminders (default false)"),
  },
  async ({ list, include_completed }) => {
    const r = await Reminders.listReminders({ listName: list, includeCompleted: include_completed ?? false });
    return { content: [{ type: "text", text: r.length ? JSON.stringify(r, null, 2) : "No reminders found." }] };
  }
);

server.tool(
  "reminders_get",
  "Get a reminder by name or ID",
  { identifier: z.string().describe("Reminder name or ID") },
  async ({ identifier }) => {
    const r = await Reminders.getReminder(identifier);
    return r
      ? { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] }
      : { content: [{ type: "text", text: `Reminder not found: ${identifier}` }], isError: true };
  }
);

server.tool(
  "reminders_search",
  "Search reminders by name, notes, or list",
  { query: z.string().describe("Search query") },
  async ({ query }) => {
    const r = await Reminders.searchReminders(query);
    return { content: [{ type: "text", text: r.length ? JSON.stringify(r, null, 2) : "No results." }] };
  }
);

server.tool(
  "reminders_create",
  "Create a reminder. Due dates accept natural language: 'tomorrow at 10am', 'next Friday', 'December 25 9:00'",
  {
    name: z.string().describe("Reminder name"),
    body: z.string().optional().describe("Notes / description"),
    list: z.string().optional().describe("List name (defaults to default list)"),
    due_date: z.string().optional().describe("Due date in natural language"),
    priority: z.number().min(0).max(9).optional().describe("Priority: 0=none, 1=high, 5=medium, 9=low"),
    url: z.string().optional().describe("URL to attach"),
  },
  async ({ name, body, list, due_date, priority, url }) => {
    const id = await Reminders.createReminder({ name, body, listName: list, dueDateInput: due_date, priority, url });
    let dateMsg = "";
    if (due_date) {
      const d = Reminders.parseNaturalDate(due_date);
      dateMsg = d ? ` · due: ${d.toLocaleString("en-US")}` : " · date not recognized";
    }
    return { content: [{ type: "text", text: `Created (${id})${dateMsg}` }] };
  }
);

server.tool(
  "reminders_create_batch",
  "Create multiple reminders in one call. All items land in the same list. Due dates accept natural language ('tomorrow at 10am', 'next Friday'). Returns a short summary — no individual IDs.",
  {
    list: z.string().describe("List to add all reminders to"),
    items: z.array(z.object({
      name: z.string().describe("Reminder name"),
      body: z.string().optional().describe("Notes / description"),
      due_date: z.string().optional().describe("Due date in natural language"),
      priority: z.number().min(0).max(9).optional().describe("Priority: 0=none, 1=high, 5=medium, 9=low"),
      url: z.string().optional().describe("URL to attach"),
    })).min(1).describe("Reminders to create"),
  },
  async ({ list, items }) => {
    const result = await Reminders.createRemindersBatch(
      items.map((item) => ({ name: item.name, body: item.body, listName: list, dueDateInput: item.due_date, priority: item.priority, url: item.url }))
    );
    const lines = [`Created ${result.created}/${items.length} reminder(s) in "${list}".`];
    if (result.errors.length > 0) {
      lines.push(`Failed: ${result.failed}`);
      for (const e of result.errors) lines.push(`  [${e.index}] "${e.name}": ${e.error}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "reminders_update",
  "Update a reminder",
  {
    identifier: z.string().describe("Reminder name or ID"),
    name: z.string().optional().describe("New name"),
    body: z.string().optional().describe("New notes"),
    due_date: z.string().optional().describe("New due date in natural language, or 'none' to remove"),
    priority: z.number().min(0).max(9).optional().describe("New priority"),
    url: z.string().optional().describe("New URL"),
    list: z.string().optional().describe("Move to list"),
  },
  async ({ identifier, name, body, due_date, priority, url, list }) => {
    await Reminders.updateReminder(identifier, { name, body, dueDateInput: due_date, priority, url, listName: list });
    return { content: [{ type: "text", text: "Reminder updated." }] };
  }
);

server.tool(
  "reminders_complete",
  "Mark a reminder as completed or incomplete",
  {
    identifier: z.string().describe("Reminder name or ID"),
    completed: z.boolean().describe("true = complete, false = incomplete"),
  },
  async ({ identifier, completed }) => {
    await Reminders.completeReminder(identifier, completed);
    return { content: [{ type: "text", text: `Marked as ${completed ? "completed" : "incomplete"}.` }] };
  }
);

server.tool(
  "reminders_delete",
  "Delete a reminder",
  { identifier: z.string().describe("Reminder name or ID") },
  async ({ identifier }) => {
    await Reminders.deleteReminder(identifier);
    return { content: [{ type: "text", text: "Reminder deleted." }] };
  }
);

server.tool(
  "reminders_create_list",
  "Create a new reminder list",
  { name: z.string().describe("List name") },
  async ({ name }) => ({
    content: [{ type: "text", text: `List created: ${await Reminders.createReminderList(name)}` }],
  })
);

server.tool(
  "reminders_delete_list",
  "Delete a reminder list and all its reminders",
  { name: z.string().describe("List name") },
  async ({ name }) => {
    await Reminders.deleteReminderList(name);
    return { content: [{ type: "text", text: "List deleted." }] };
  }
);

server.tool(
  "reminders_add_subtask",
  "Add a subtask to a reminder",
  {
    parent: z.string().describe("Parent reminder name or ID"),
    name: z.string().describe("Subtask name"),
  },
  async ({ parent, name }) => ({
    content: [{ type: "text", text: `Subtask created: ${await Reminders.addSubtask(parent, name)}` }],
  })
);

server.tool(
  "reminders_complete_subtask",
  "Mark a subtask as completed or incomplete",
  {
    parent: z.string().describe("Parent reminder name or ID"),
    subtask: z.string().describe("Subtask name or ID"),
    completed: z.boolean().describe("true = complete, false = incomplete"),
  },
  async ({ parent, subtask, completed }) => {
    await Reminders.completeSubtask(parent, subtask, completed);
    return { content: [{ type: "text", text: `Subtask ${completed ? "completed" : "restored"}.` }] };
  }
);

server.tool(
  "reminders_delete_completed",
  "Delete all completed reminders. Optionally scoped to one list. Filtering and deletion happen server-side — no need to fetch or pass individual IDs.",
  { list: z.string().optional().describe("List name to scope deletion to (omit to delete across all lists)") },
  async ({ list }) => {
    const result = await Reminders.deleteCompletedReminders(list);
    const scope = list ? `from "${list}"` : "across all lists";
    const msg = `Deleted ${result.deleted}/${result.total} completed reminders ${scope}.`;
    const suffix = result.failed > 0 ? ` (${result.failed} failed to delete)` : "";
    return { content: [{ type: "text", text: msg + suffix }] };
  }
);

// ─── Reminders: filter-based bulk operations ──────────────────────────────────
// Describe which reminders to act on in words; the server filters and acts
// natively. The caller never fetches, sees, or passes individual IDs.

const reminderFilterShape = {
  list: z.string().optional().describe("Restrict to this list"),
  completed: z.boolean().optional().describe("Match completed (true) or incomplete (false) only"),
  search: z.string().optional().describe("Substring matched against title and notes"),
  due_before: z.string().optional().describe("Match reminders due before this date (natural language, e.g. 'today', 'next Monday')"),
  due_after: z.string().optional().describe("Match reminders due after this date (natural language)"),
  priority: z.number().min(0).max(9).optional().describe("Match exact priority (0=none,1=high,5=medium,9=low)"),
  has_due_date: z.boolean().optional().describe("Match only reminders that have (true) or lack (false) a due date"),
};

const toReminderFilter = (a: {
  list?: string; completed?: boolean; search?: string;
  due_before?: string; due_after?: string; priority?: number; has_due_date?: boolean;
}): Reminders.ReminderFilter => ({
  list: a.list, completed: a.completed, search: a.search,
  dueBefore: a.due_before, dueAfter: a.due_after, priority: a.priority, hasDueDate: a.has_due_date,
});

server.tool(
  "reminders_query_where",
  "Count or list reminders matching a word-based filter (list, completed, search text, due-date range, priority, has-due-date). Use count_only to preview how many a filter matches before a bulk action.",
  { ...reminderFilterShape, count_only: z.boolean().optional().describe("Return only the match count instead of full reminders (default false)") },
  async ({ count_only, ...filter }) => {
    const result = await Reminders.queryRemindersWhere(toReminderFilter(filter), count_only ?? false);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "reminders_delete_where",
  "Delete all reminders matching a word-based filter. SAFETY: without confirm=true, returns only the match count and deletes nothing — call again with confirm=true to delete.",
  { ...reminderFilterShape, confirm: z.boolean().optional().describe("Set true to actually delete; otherwise returns the count only") },
  async ({ confirm, ...filter }) => {
    const r = await Reminders.deleteRemindersWhere(toReminderFilter(filter), confirm ?? false);
    if (!("confirmed" in r) || r.confirmed === false) {
      return { content: [{ type: "text", text: `${(r as any).count} reminder(s) match. Re-call with confirm=true to delete them.` }] };
    }
    const suffix = r.failed > 0 ? ` (${r.failed} failed)` : "";
    return { content: [{ type: "text", text: `Deleted ${r.deleted}/${r.total} matching reminder(s).${suffix}` }] };
  }
);

server.tool(
  "reminders_complete_where",
  "Mark all reminders matching a word-based filter as completed or incomplete. SAFETY: without confirm=true, returns only the match count and changes nothing.",
  {
    ...reminderFilterShape,
    set_completed: z.boolean().optional().describe("true = mark completed (default), false = mark incomplete"),
    confirm: z.boolean().optional().describe("Set true to actually apply; otherwise returns the count only"),
  },
  async ({ set_completed, confirm, ...filter }) => {
    const target = set_completed ?? true;
    const r = await Reminders.completeRemindersWhere(toReminderFilter(filter), target, confirm ?? false);
    if (!("confirmed" in r) || r.confirmed === false) {
      return { content: [{ type: "text", text: `${(r as any).count} reminder(s) match. Re-call with confirm=true to mark them ${target ? "completed" : "incomplete"}.` }] };
    }
    const suffix = r.failed > 0 ? ` (${r.failed} failed)` : "";
    return { content: [{ type: "text", text: `Marked ${r.updated}/${r.total} reminder(s) ${target ? "completed" : "incomplete"}.${suffix}` }] };
  }
);

server.tool(
  "reminders_move_where",
  "Move all reminders matching a word-based filter to another list. SAFETY: without confirm=true, returns only the match count and moves nothing.",
  {
    ...reminderFilterShape,
    destination_list: z.string().describe("Name of the list to move matching reminders into"),
    confirm: z.boolean().optional().describe("Set true to actually move; otherwise returns the count only"),
  },
  async ({ destination_list, confirm, ...filter }) => {
    const r = await Reminders.moveRemindersWhere(toReminderFilter(filter), destination_list, confirm ?? false);
    if (!("confirmed" in r) || r.confirmed === false) {
      return { content: [{ type: "text", text: `${(r as any).count} reminder(s) match. Re-call with confirm=true to move them to "${destination_list}".` }] };
    }
    const suffix = r.failed > 0 ? ` (${r.failed} failed)` : "";
    return { content: [{ type: "text", text: `Moved ${r.moved}/${r.total} reminder(s) to "${destination_list}".${suffix}` }] };
  }
);

// ─── Notes: filter-based bulk operations ──────────────────────────────────────

const noteFilterShape = {
  folder: z.string().optional().describe("Restrict to this folder"),
  search: z.string().optional().describe("Substring matched against title and body"),
};

server.tool(
  "notes_query_where",
  "Count or list notes matching a word-based filter (folder, search text). Use count_only to preview how many a filter matches before a bulk action.",
  { ...noteFilterShape, count_only: z.boolean().optional().describe("Return only the match count instead of full notes (default false)") },
  async ({ folder, search, count_only }) => {
    const result = await Notes.queryNotesWhere({ folder, search }, count_only ?? false);
    if ("count" in result) {
      const warn = result.skipped > 0 ? `\n[${result.skipped} note(s) skipped — could not read their properties]` : "";
      return { content: [{ type: "text", text: JSON.stringify({ count: result.count }, null, 2) + warn }] };
    }
    const text = result.results.length ? JSON.stringify(result.results, null, 2) : "No notes match.";
    const warn = result.skipped > 0 ? `\n[${result.skipped} note(s) skipped — could not read their properties]` : "";
    return { content: [{ type: "text", text: text + warn }] };
  }
);

server.tool(
  "notes_delete_where",
  "Delete all notes matching a word-based filter. SAFETY: without confirm=true, returns only the match count and deletes nothing — call again with confirm=true to delete.",
  { ...noteFilterShape, confirm: z.boolean().optional().describe("Set true to actually delete; otherwise returns the count only") },
  async ({ folder, search, confirm }) => {
    const r = await Notes.deleteNotesWhere({ folder, search }, confirm ?? false);
    const warn = r.skipped > 0 ? ` [${r.skipped} note(s) skipped — could not read their properties]` : "";
    if (!r.confirmed) {
      return { content: [{ type: "text", text: `${r.count} note(s) match. Re-call with confirm=true to delete them.${warn}` }] };
    }
    return { content: [{ type: "text", text: `Deleted ${r.deleted} matching note(s).${warn}` }] };
  }
);

server.tool(
  "notes_move_where",
  "Move all notes matching a word-based filter to another folder. SAFETY: without confirm=true, returns only the match count and moves nothing.",
  {
    ...noteFilterShape,
    destination_folder: z.string().describe("Name of the folder to move matching notes into"),
    confirm: z.boolean().optional().describe("Set true to actually move; otherwise returns the count only"),
  },
  async ({ folder, search, destination_folder, confirm }) => {
    const r = await Notes.moveNotesWhere({ folder, search }, destination_folder, confirm ?? false);
    const warn = r.skipped > 0 ? ` [${r.skipped} note(s) skipped — could not read their properties]` : "";
    if (!r.confirmed) {
      return { content: [{ type: "text", text: `${r.count} note(s) match. Re-call with confirm=true to move them to "${destination_folder}".${warn}` }] };
    }
    return { content: [{ type: "text", text: `Moved ${r.moved} note(s) to "${destination_folder}".${warn}` }] };
  }
);

// ─── Start ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
