import Foundation
import EventKit

// MARK: - Output

func output(_ value: Any) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}

func outputError(_ message: String) -> Never {
    output(["error": message])
}

// MARK: - EventKit setup

let store = EKEventStore()

func requestAccess() {
    let sema = DispatchSemaphore(value: 0)
    if #available(macOS 14.0, *) {
        store.requestFullAccessToReminders { _, _ in sema.signal() }
    } else {
        store.requestAccess(to: .reminder) { _, _ in sema.signal() }
    }
    sema.wait()
}

// MARK: - Lookup helpers

func findList(named name: String) -> EKCalendar? {
    store.calendars(for: .reminder).first { $0.title.lowercased() == name.lowercased() }
}

func findReminder(identifier: String) -> EKReminder? {
    if let item = store.calendarItem(withIdentifier: identifier) as? EKReminder {
        return item
    }
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

// MARK: - Serialization

func reminderToDict(_ r: EKReminder) -> [String: Any] {
    var dict: [String: Any] = [
        "id": r.calendarItemIdentifier,
        "name": r.title ?? "",
        "list": r.calendar?.title ?? "",
        "isCompleted": r.isCompleted,
        "priority": r.priority,
        "body": r.notes ?? "",
        "url": r.url?.absoluteString ?? "",
        "hasAlarms": !(r.alarms?.isEmpty ?? true),
    ]
    if let due = r.dueDateComponents?.date {
        dict["dueDate"] = ISO8601DateFormatter().string(from: due)
    } else {
        dict["dueDate"] = ""
    }
    if let comp = r.completionDate {
        dict["completionDate"] = ISO8601DateFormatter().string(from: comp)
    } else {
        dict["completionDate"] = ""
    }
    return dict
}

func listToDict(_ cal: EKCalendar) -> [String: Any] {
    ["id": cal.calendarIdentifier, "name": cal.title]
}

// MARK: - Commands

func cmdListLists() {
    output(store.calendars(for: .reminder).map(listToDict))
}

func cmdListReminders(params: [String: Any]) {
    let listName = params["listName"] as? String
    let includeCompleted = params["includeCompleted"] as? Bool ?? false

    var calendars: [EKCalendar]? = nil
    if let name = listName {
        guard let cal = findList(named: name) else { outputError("List not found: \(name)") }
        calendars = [cal]
    }

    let pred = store.predicateForReminders(in: calendars)
    var results: [[String: Any]] = []
    let sema = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: pred) { reminders in
        results = (reminders ?? [])
            .filter { includeCompleted || !$0.isCompleted }
            .map(reminderToDict)
        sema.signal()
    }
    sema.wait()
    output(results)
}

func cmdGetReminder(params: [String: Any]) {
    guard let identifier = params["identifier"] as? String else { outputError("identifier required") }
    guard let r = findReminder(identifier: identifier) else { outputError("Reminder not found: \(identifier)") }
    output(reminderToDict(r))
}

func cmdSearchReminders(params: [String: Any]) {
    guard let query = params["query"] as? String else { outputError("query required") }
    let q = query.lowercased()
    let pred = store.predicateForReminders(in: nil)
    var results: [[String: Any]] = []
    let sema = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: pred) { reminders in
        results = (reminders ?? [])
            .filter {
                ($0.title?.lowercased().contains(q) ?? false) ||
                ($0.notes?.lowercased().contains(q) ?? false) ||
                ($0.calendar?.title.lowercased().contains(q) ?? false)
            }
            .map(reminderToDict)
        sema.signal()
    }
    sema.wait()
    output(results)
}

func parseDate(_ input: String) -> DateComponents? {
    let iso = ISO8601DateFormatter()
    if let d = iso.date(from: input) {
        return Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: d)
    }
    return nil
}

func cmdCreateReminder(params: [String: Any]) {
    guard let name = params["name"] as? String else { outputError("name required") }

    let reminder = EKReminder(eventStore: store)
    reminder.title = name

    if let listName = params["listName"] as? String {
        guard let cal = findList(named: listName) else { outputError("List not found: \(listName)") }
        reminder.calendar = cal
    } else {
        reminder.calendar = store.defaultCalendarForNewReminders()
    }

    if let body = params["body"] as? String { reminder.notes = body }
    if let priority = params["priority"] as? Int { reminder.priority = priority }
    if let urlStr = params["url"] as? String { reminder.url = URL(string: urlStr) }

    if let dueDateISO = params["dueDate"] as? String, let comps = parseDate(dueDateISO) {
        reminder.dueDateComponents = comps
        reminder.addAlarm(EKAlarm(absoluteDate: Calendar.current.date(from: comps)!))
    }

    do {
        try store.save(reminder, commit: true)
        output(["id": reminder.calendarItemIdentifier, "name": reminder.title ?? ""])
    } catch {
        outputError("Save failed: \(error.localizedDescription)")
    }
}

func cmdUpdateReminder(params: [String: Any]) {
    guard let identifier = params["identifier"] as? String else { outputError("identifier required") }
    guard let r = findReminder(identifier: identifier) else { outputError("Reminder not found: \(identifier)") }

    if let name = params["name"] as? String { r.title = name }
    if let body = params["body"] as? String { r.notes = body }
    if let priority = params["priority"] as? Int { r.priority = priority }
    if let urlStr = params["url"] as? String { r.url = URL(string: urlStr) }

    if let dueDateISO = params["dueDate"] as? String {
        if dueDateISO == "none" || dueDateISO == "remove" {
            r.dueDateComponents = nil
            r.alarms?.forEach { r.removeAlarm($0) }
        } else if let comps = parseDate(dueDateISO) {
            r.dueDateComponents = comps
        }
    }

    if let listName = params["listName"] as? String {
        guard let cal = findList(named: listName) else { outputError("List not found: \(listName)") }
        r.calendar = cal
    }

    do {
        try store.save(r, commit: true)
        output(["ok": true])
    } catch {
        outputError("Update failed: \(error.localizedDescription)")
    }
}

func cmdCompleteReminder(params: [String: Any]) {
    guard let identifier = params["identifier"] as? String else { outputError("identifier required") }
    guard let completed = params["completed"] as? Bool else { outputError("completed required") }
    guard let r = findReminder(identifier: identifier) else { outputError("Reminder not found: \(identifier)") }

    r.isCompleted = completed
    do {
        try store.save(r, commit: true)
        output(["ok": true])
    } catch {
        outputError("Update failed: \(error.localizedDescription)")
    }
}

func cmdDeleteReminder(params: [String: Any]) {
    guard let identifier = params["identifier"] as? String else { outputError("identifier required") }
    guard let r = findReminder(identifier: identifier) else { outputError("Reminder not found: \(identifier)") }

    do {
        try store.remove(r, commit: true)
        output(["ok": true])
    } catch {
        outputError("Delete failed: \(error.localizedDescription)")
    }
}

func cmdCreateList(params: [String: Any]) {
    guard let name = params["name"] as? String else { outputError("name required") }

    let source = store.sources.first(where: { $0.sourceType == .local })
        ?? store.sources.first(where: { $0.sourceType == .calDAV })
        ?? store.sources.first

    let cal = EKCalendar(for: .reminder, eventStore: store)
    cal.title = name
    if let src = source { cal.source = src }

    do {
        try store.saveCalendar(cal, commit: true)
        output(["id": cal.calendarIdentifier, "name": cal.title])
    } catch {
        outputError("List creation failed: \(error.localizedDescription)")
    }
}

func cmdDeleteList(params: [String: Any]) {
    guard let name = params["name"] as? String else { outputError("name required") }
    guard let cal = findList(named: name) else { outputError("List not found: \(name)") }

    do {
        try store.removeCalendar(cal, commit: true)
        output(["ok": true])
    } catch {
        outputError("Delete failed: \(error.localizedDescription)")
    }
}

// Emit a single JSON line to stdout immediately (for streaming progress).
func emitLine(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value)
    var out = String(data: data, encoding: .utf8)!
    out += "\n"
    FileHandle.standardOutput.write(out.data(using: .utf8)!)
}

func cmdDeleteRemindersBatch(params: [String: Any]) {
    guard let identifiers = params["identifiers"] as? [String] else { outputError("identifiers required") }
    guard !identifiers.isEmpty else {
        print("[]")
        exit(0)
    }

    // Fast path: calendarItem(withIdentifier:) is synchronous and O(1) — no full DB scan.
    // Slow path: only fetch all reminders for identifiers that aren't EK calendar item IDs.
    var resolved: [String: EKReminder] = [:]
    var needsNameLookup: [String] = []

    for identifier in identifiers {
        if let item = store.calendarItem(withIdentifier: identifier) as? EKReminder {
            resolved[identifier] = item
        } else {
            needsNameLookup.append(identifier)
        }
    }

    // Only do the expensive full fetch if there are name-based identifiers
    if !needsNameLookup.isEmpty {
        let pred = store.predicateForReminders(in: nil)
        let sema = DispatchSemaphore(value: 0)
        store.fetchReminders(matching: pred) { reminders in
            for reminder in reminders ?? [] {
                if let title = reminder.title, needsNameLookup.contains(title) {
                    resolved[title] = reminder
                }
            }
            sema.signal()
        }
        sema.wait()
    }

    // Remove each reminder with commit:false, streaming one JSON line per result
    var committedOk = [String]()
    for identifier in identifiers {
        guard let r = resolved[identifier] else {
            emitLine(["identifier": identifier, "ok": false, "error": "Not found"])
            continue
        }
        do {
            try store.remove(r, commit: false)
            committedOk.append(identifier)
            emitLine(["identifier": identifier, "ok": true, "pending": true])
        } catch {
            emitLine(["identifier": identifier, "ok": false, "error": error.localizedDescription])
        }
    }

    // Single commit for all pending removals
    do {
        try store.commit()
        // Confirm all pending deletions succeeded
        for identifier in committedOk {
            emitLine(["identifier": identifier, "ok": true, "committed": true])
        }
    } catch {
        // Commit failed — mark all pending as failed
        for identifier in committedOk {
            emitLine(["identifier": identifier, "ok": false, "error": "Commit failed: \(error.localizedDescription)"])
        }
    }

    emitLine(["done": true])
    exit(0)
}

// MARK: - Entry point

let args = CommandLine.arguments
guard args.count >= 2 else { outputError("No command provided") }

let command = args[1]
let paramsData = args.count >= 3 ? args[2].data(using: .utf8) ?? Data() : Data()
let params = (try? JSONSerialization.jsonObject(with: paramsData)) as? [String: Any] ?? [:]

requestAccess()

switch command {
case "list-lists":        cmdListLists()
case "list-reminders":    cmdListReminders(params: params)
case "get-reminder":      cmdGetReminder(params: params)
case "search-reminders":  cmdSearchReminders(params: params)
case "create-reminder":   cmdCreateReminder(params: params)
case "update-reminder":   cmdUpdateReminder(params: params)
case "complete-reminder": cmdCompleteReminder(params: params)
case "delete-reminder":        cmdDeleteReminder(params: params)
case "delete-reminders-batch": cmdDeleteRemindersBatch(params: params)
case "create-list":            cmdCreateList(params: params)
case "delete-list":       cmdDeleteList(params: params)
default:                  outputError("Unknown command: \(command)")
}
