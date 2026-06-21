import Foundation
import EventKit

// MARK: - Globals

let store = EKEventStore()

// MARK: - IPC helpers

/// Write a single JSON line to stdout, bypassing stdio buffering.
func writeLine(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let str = String(data: data, encoding: .utf8)
    else { return }
    FileHandle.standardOutput.write((str + "\n").data(using: .utf8)!)
}

func respond(id: String, result: Any) {
    writeLine(["id": id, "result": result])
}

func respondError(id: String, message: String) {
    writeLine(["id": id, "error": message])
}

// MARK: - EventKit init

func requestAccess() {
    let sema = DispatchSemaphore(value: 0)
    if #available(macOS 14.0, *) {
        store.requestFullAccessToReminders { _, _ in sema.signal() }
    } else {
        store.requestAccess(to: .reminder) { _, _ in sema.signal() }
    }
    sema.wait()
}

// MARK: - Helpers

func findList(named name: String) -> EKCalendar? {
    store.calendars(for: .reminder).first { $0.title.lowercased() == name.lowercased() }
}

/// Fast O(1) lookup by EK identifier; falls back to a name scan if needed.
func findReminder(identifier: String) -> EKReminder? {
    if let item = store.calendarItem(withIdentifier: identifier) as? EKReminder { return item }
    let pred = store.predicateForReminders(in: nil)
    var found: EKReminder?
    let sema = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: pred) { reminders in
        found = reminders?.first { $0.title == identifier }
        sema.signal()
    }
    sema.wait()
    return found
}

func reminderToDict(_ r: EKReminder) -> [String: Any] {
    let iso = ISO8601DateFormatter()
    var dict: [String: Any] = [
        "id": r.calendarItemIdentifier,
        "name": r.title ?? "",
        "list": r.calendar?.title ?? "",
        "isCompleted": r.isCompleted,
        "priority": r.priority,
        "body": r.notes ?? "",
        "url": r.url?.absoluteString ?? "",
        "hasAlarms": !(r.alarms?.isEmpty ?? true),
        "dueDate": r.dueDateComponents?.date.map { iso.string(from: $0) } ?? "",
        "completionDate": r.completionDate.map { iso.string(from: $0) } ?? "",
    ]
    return dict
}

func listToDict(_ cal: EKCalendar) -> [String: Any] {
    ["id": cal.calendarIdentifier, "name": cal.title]
}

func parseDate(_ iso: String) -> DateComponents? {
    if let d = ISO8601DateFormatter().date(from: iso) {
        return Calendar.current.dateComponents([.year,.month,.day,.hour,.minute,.second], from: d)
    }
    return nil
}

// MARK: - Command handlers

func handleListLists(id: String) {
    respond(id: id, result: store.calendars(for: .reminder).map(listToDict))
}

func handleListReminders(id: String, params: [String: Any]) {
    let listName = params["listName"] as? String
    let includeCompleted = params["includeCompleted"] as? Bool ?? false
    var cals: [EKCalendar]? = nil
    if let name = listName {
        guard let cal = findList(named: name) else { respondError(id: id, message: "List not found: \(name)"); return }
        cals = [cal]
    }
    let pred = store.predicateForReminders(in: cals)
    let sema = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: pred) { reminders in
        let r = (reminders ?? []).filter { includeCompleted || !$0.isCompleted }.map(reminderToDict)
        DispatchQueue.global().async { respond(id: id, result: r); sema.signal() }
    }
    sema.wait()
}

func handleGetReminder(id: String, params: [String: Any]) {
    guard let identifier = params["identifier"] as? String else { respondError(id: id, message: "identifier required"); return }
    guard let r = findReminder(identifier: identifier) else { respondError(id: id, message: "Reminder not found: \(identifier)"); return }
    respond(id: id, result: reminderToDict(r))
}

func handleSearchReminders(id: String, params: [String: Any]) {
    guard let query = params["query"] as? String else { respondError(id: id, message: "query required"); return }
    let q = query.lowercased()
    let pred = store.predicateForReminders(in: nil)
    let sema = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: pred) { reminders in
        let r = (reminders ?? []).filter {
            ($0.title?.lowercased().contains(q) ?? false) ||
            ($0.notes?.lowercased().contains(q) ?? false) ||
            ($0.calendar?.title.lowercased().contains(q) ?? false)
        }.map(reminderToDict)
        DispatchQueue.global().async { respond(id: id, result: r); sema.signal() }
    }
    sema.wait()
}

func handleCreateReminder(id: String, params: [String: Any]) {
    guard let name = params["name"] as? String else { respondError(id: id, message: "name required"); return }
    let r = EKReminder(eventStore: store)
    r.title = name
    if let listName = params["listName"] as? String {
        guard let cal = findList(named: listName) else { respondError(id: id, message: "List not found: \(listName)"); return }
        r.calendar = cal
    } else {
        r.calendar = store.defaultCalendarForNewReminders()
    }
    if let body = params["body"] as? String { r.notes = body }
    if let priority = params["priority"] as? Int { r.priority = priority }
    if let urlStr = params["url"] as? String { r.url = URL(string: urlStr) }
    if let dueISO = params["dueDate"] as? String, let comps = parseDate(dueISO) {
        r.dueDateComponents = comps
        r.addAlarm(EKAlarm(absoluteDate: Calendar.current.date(from: comps)!))
    }
    do {
        try store.save(r, commit: true)
        respond(id: id, result: ["id": r.calendarItemIdentifier, "name": r.title ?? ""])
    } catch {
        respondError(id: id, message: "Save failed: \(error.localizedDescription)")
    }
}

func handleUpdateReminder(id: String, params: [String: Any]) {
    guard let identifier = params["identifier"] as? String else { respondError(id: id, message: "identifier required"); return }
    guard let r = findReminder(identifier: identifier) else { respondError(id: id, message: "Reminder not found: \(identifier)"); return }
    if let name = params["name"] as? String { r.title = name }
    if let body = params["body"] as? String { r.notes = body }
    if let priority = params["priority"] as? Int { r.priority = priority }
    if let urlStr = params["url"] as? String { r.url = URL(string: urlStr) }
    if let dueISO = params["dueDate"] as? String {
        if dueISO == "none" || dueISO == "remove" {
            r.dueDateComponents = nil
            r.alarms?.forEach { r.removeAlarm($0) }
        } else if let comps = parseDate(dueISO) {
            r.dueDateComponents = comps
        }
    }
    if let listName = params["listName"] as? String {
        guard let cal = findList(named: listName) else { respondError(id: id, message: "List not found: \(listName)"); return }
        r.calendar = cal
    }
    do {
        try store.save(r, commit: true)
        respond(id: id, result: ["ok": true])
    } catch {
        respondError(id: id, message: "Update failed: \(error.localizedDescription)")
    }
}

func handleCompleteReminder(id: String, params: [String: Any]) {
    guard let identifier = params["identifier"] as? String else { respondError(id: id, message: "identifier required"); return }
    guard let completed = params["completed"] as? Bool else { respondError(id: id, message: "completed required"); return }
    guard let r = findReminder(identifier: identifier) else { respondError(id: id, message: "Reminder not found: \(identifier)"); return }
    r.isCompleted = completed
    do {
        try store.save(r, commit: true)
        respond(id: id, result: ["ok": true])
    } catch {
        respondError(id: id, message: "Update failed: \(error.localizedDescription)")
    }
}

func handleDeleteReminder(id: String, params: [String: Any]) {
    guard let identifier = params["identifier"] as? String else { respondError(id: id, message: "identifier required"); return }
    guard let r = findReminder(identifier: identifier) else { respondError(id: id, message: "Reminder not found: \(identifier)"); return }
    do {
        try store.remove(r, commit: true)
        respond(id: id, result: ["ok": true])
    } catch {
        respondError(id: id, message: "Delete failed: \(error.localizedDescription)")
    }
}

func handleCreateList(id: String, params: [String: Any]) {
    guard let name = params["name"] as? String else { respondError(id: id, message: "name required"); return }
    let source = store.sources.first(where: { $0.sourceType == .local })
        ?? store.sources.first(where: { $0.sourceType == .calDAV })
        ?? store.sources.first
    let cal = EKCalendar(for: .reminder, eventStore: store)
    cal.title = name
    if let src = source { cal.source = src }
    do {
        try store.saveCalendar(cal, commit: true)
        respond(id: id, result: ["id": cal.calendarIdentifier, "name": cal.title])
    } catch {
        respondError(id: id, message: "List creation failed: \(error.localizedDescription)")
    }
}

func handleDeleteList(id: String, params: [String: Any]) {
    guard let name = params["name"] as? String else { respondError(id: id, message: "name required"); return }
    guard let cal = findList(named: name) else { respondError(id: id, message: "List not found: \(name)"); return }
    do {
        try store.removeCalendar(cal, commit: true)
        respond(id: id, result: ["ok": true])
    } catch {
        respondError(id: id, message: "Delete failed: \(error.localizedDescription)")
    }
}


/// Delete all completed reminders, optionally scoped to a single list.
/// Returns {"deleted": N, "failed": M}.
func handleDeleteCompleted(id: String, params: [String: Any]) {
    let listName = params["listName"] as? String

    var calendars: [EKCalendar]? = nil
    if let name = listName {
        guard let cal = findList(named: name) else {
            respondError(id: id, message: "List not found: \(name)"); return
        }
        calendars = [cal]
    }

    let pred = store.predicateForReminders(in: calendars)
    var toDelete: [EKReminder] = []
    let sema = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: pred) { reminders in
        toDelete = (reminders ?? []).filter { $0.isCompleted }
        sema.signal()
    }
    sema.wait()

    var deleted = 0
    var failed = 0
    for r in toDelete {
        do {
            try store.remove(r, commit: false)
            deleted += 1
        } catch {
            failed += 1
        }
    }

    if deleted > 0 {
        do {
            try store.commit()
        } catch {
            // Commit failed — all staged deletions are lost
            failed += deleted
            deleted = 0
        }
    }

    respond(id: id, result: ["deleted": deleted, "failed": failed, "total": toDelete.count])
}

// MARK: - Filter-based bulk operations

/// Shared filter spec. All fields optional; a reminder must satisfy every
/// provided field to match. List scoping uses the EventKit predicate (fast);
/// the rest is applied in a post-fetch filter.
/// Returns (matches, error) — error is non-nil only when a named list is missing.
func matchingReminders(params: [String: Any]) -> (matches: [EKReminder]?, error: String?) {
    var cals: [EKCalendar]? = nil
    if let name = params["listName"] as? String {
        guard let cal = findList(named: name) else { return (nil, "List not found: \(name)") }
        cals = [cal]
    }

    let search = (params["search"] as? String)?.lowercased()
    let completed = params["completed"] as? Bool
    let priority = params["priority"] as? Int
    let hasDueDate = params["hasDueDate"] as? Bool
    let iso = ISO8601DateFormatter()
    let dueBefore = (params["dueBefore"] as? String).flatMap { iso.date(from: $0) }
    let dueAfter = (params["dueAfter"] as? String).flatMap { iso.date(from: $0) }

    let pred = store.predicateForReminders(in: cals)
    var result: [EKReminder] = []
    let sema = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: pred) { reminders in
        result = (reminders ?? []).filter { r in
            if let c = completed, r.isCompleted != c { return false }
            if let p = priority, r.priority != p { return false }
            if let h = hasDueDate, (r.dueDateComponents?.date != nil) != h { return false }
            if let s = search, !s.isEmpty {
                let inTitle = r.title?.lowercased().contains(s) ?? false
                let inNotes = r.notes?.lowercased().contains(s) ?? false
                if !inTitle && !inNotes { return false }
            }
            if dueBefore != nil || dueAfter != nil {
                guard let due = r.dueDateComponents?.date else { return false }
                if let b = dueBefore, due >= b { return false }
                if let a = dueAfter, due <= a { return false }
            }
            return true
        }
        sema.signal()
    }
    sema.wait()
    return (result, nil)
}

func handleQueryWhere(id: String, params: [String: Any]) {
    let (matches, err) = matchingReminders(params: params)
    if let err = err { respondError(id: id, message: err); return }
    let m = matches ?? []
    if params["countOnly"] as? Bool ?? false {
        respond(id: id, result: ["count": m.count])
    } else {
        respond(id: id, result: m.map(reminderToDict))
    }
}

func handleDeleteWhere(id: String, params: [String: Any]) {
    let (matches, err) = matchingReminders(params: params)
    if let err = err { respondError(id: id, message: err); return }
    let m = matches ?? []
    guard params["confirm"] as? Bool ?? false else {
        respond(id: id, result: ["count": m.count, "confirmed": false]); return
    }
    var deleted = 0, failed = 0
    for r in m {
        do { try store.remove(r, commit: false); deleted += 1 } catch { failed += 1 }
    }
    if deleted > 0 {
        do { try store.commit() } catch { failed += deleted; deleted = 0 }
    }
    respond(id: id, result: ["deleted": deleted, "failed": failed, "total": m.count, "confirmed": true])
}

func handleCompleteWhere(id: String, params: [String: Any]) {
    let target = params["setCompleted"] as? Bool ?? true
    let (matches, err) = matchingReminders(params: params)
    if let err = err { respondError(id: id, message: err); return }
    let m = matches ?? []
    guard params["confirm"] as? Bool ?? false else {
        respond(id: id, result: ["count": m.count, "confirmed": false]); return
    }
    var updated = 0, failed = 0
    for r in m {
        r.isCompleted = target
        do { try store.save(r, commit: false); updated += 1 } catch { failed += 1 }
    }
    if updated > 0 {
        do { try store.commit() } catch { failed += updated; updated = 0 }
    }
    respond(id: id, result: ["updated": updated, "failed": failed, "total": m.count, "confirmed": true])
}

func handleMoveWhere(id: String, params: [String: Any]) {
    guard let dest = params["destinationList"] as? String else {
        respondError(id: id, message: "destinationList required"); return
    }
    guard let destCal = findList(named: dest) else {
        respondError(id: id, message: "Destination list not found: \(dest)"); return
    }
    let (matches, err) = matchingReminders(params: params)
    if let err = err { respondError(id: id, message: err); return }
    let m = matches ?? []
    guard params["confirm"] as? Bool ?? false else {
        respond(id: id, result: ["count": m.count, "confirmed": false]); return
    }
    var moved = 0, failed = 0
    for r in m {
        r.calendar = destCal
        do { try store.save(r, commit: false); moved += 1 } catch { failed += 1 }
    }
    if moved > 0 {
        do { try store.commit() } catch { failed += moved; moved = 0 }
    }
    respond(id: id, result: ["moved": moved, "failed": failed, "total": m.count, "confirmed": true])
}

// MARK: - Dispatch

func handleCommand(id: String, command: String, params: [String: Any]) {
    switch command {
    case "list-lists":           handleListLists(id: id)
    case "list-reminders":       handleListReminders(id: id, params: params)
    case "get-reminder":         handleGetReminder(id: id, params: params)
    case "search-reminders":     handleSearchReminders(id: id, params: params)
    case "create-reminder":      handleCreateReminder(id: id, params: params)
    case "update-reminder":      handleUpdateReminder(id: id, params: params)
    case "complete-reminder":    handleCompleteReminder(id: id, params: params)
    case "delete-reminder":      handleDeleteReminder(id: id, params: params)
    case "create-list":          handleCreateList(id: id, params: params)
    case "delete-list":          handleDeleteList(id: id, params: params)
    case "delete-completed":     handleDeleteCompleted(id: id, params: params)
    case "query-where":          handleQueryWhere(id: id, params: params)
    case "delete-where":         handleDeleteWhere(id: id, params: params)
    case "complete-where":       handleCompleteWhere(id: id, params: params)
    case "move-where":           handleMoveWhere(id: id, params: params)
    default:                     respondError(id: id, message: "Unknown command: \(command)")
    }
}

// MARK: - Entry point

requestAccess()

// Signal readiness
writeLine(["ready": true])

// NDJSON read loop
while let line = readLine() {
    guard !line.isEmpty,
          let data = line.data(using: .utf8),
          let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id   = msg["id"] as? String,
          let cmd  = msg["command"] as? String
    else { continue }
    handleCommand(id: id, command: cmd, params: msg["params"] as? [String: Any] ?? [:])
}
