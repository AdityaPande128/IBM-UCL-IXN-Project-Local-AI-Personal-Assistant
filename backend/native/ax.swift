import Cocoa
import ApplicationServices


func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func text(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attr(element, name) else { return nil }
    if let s = value as? String { return s.isEmpty ? nil : s }
    if let u = value as? NSURL { return u.absoluteString }
    if let u = value as? URL { return u.absoluteString }
    if let n = value as? NSNumber { return n.stringValue }
    return nil
}

func bool(_ element: AXUIElement, _ name: String) -> Bool? {
    guard let value = attr(element, name) as? NSNumber else { return nil }
    return value.boolValue
}

func kids(_ element: AXUIElement) -> [AXUIElement] {
    (attr(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func rect(_ element: AXUIElement) -> CGRect? {
    guard let p = attr(element, kAXPositionAttribute as String),
          let s = attr(element, kAXSizeAttribute as String) else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &point)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    return CGRect(origin: point, size: size)
}

func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

let ACTIONABLE: Set<String> = [
    "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXComboBox", "AXTab", "AXSlider",
    "AXIncrementor", "AXDisclosureTriangle", "AXSearchField"
]

let READABLE: Set<String> = ["AXStaticText", "AXHeading", "AXCell"]

func webRole(_ axRole: String, _ subrole: String?) -> String {
    if subrole == "AXSecureTextField" { return "textbox" }
    switch axRole {
    case "AXButton", "AXMenuButton", "AXDisclosureTriangle": return "button"
    case "AXLink": return "link"
    case "AXTextField", "AXTextArea": return "textbox"
    case "AXSearchField": return "searchbox"
    case "AXCheckBox": return "checkbox"
    case "AXRadioButton": return "radio"
    case "AXPopUpButton", "AXComboBox": return "combobox"
    case "AXMenuItem": return "menuitem"
    case "AXTab": return "tab"
    case "AXStaticText", "AXHeading", "AXCell": return "text"
    default: return axRole.replacingOccurrences(of: "AX", with: "").lowercased()
    }
}

func name(_ element: AXUIElement) -> String {
    for key in [kAXTitleAttribute as String, kAXDescriptionAttribute as String,
                "AXHelp", kAXValueAttribute as String, kAXPlaceholderValueAttribute as String] {
        if let found = text(element, key) {
            return found.replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespaces)
        }
    }
    return ""
}


func application(named wanted: String) -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.localizedName == wanted }
}

@discardableResult
func reopen(_ appName: String) -> Bool {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    task.arguments = ["-a", appName]
    do { try task.run() } catch { return false }
    task.waitUntilExit()
    return task.terminationStatus == 0
}

func enableWebAccessibility(_ app: AXUIElement) {
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

func treeSize(_ window: AXUIElement, cap: Int = 20000) -> Int {
    var seen = 0
    func count(_ element: AXUIElement, _ depth: Int) {
        if seen >= cap || depth > 60 { return }
        seen += 1
        for child in kids(element) { count(child, depth + 1) }
    }
    count(window, 0)
    return seen
}

func focusedWindow(_ app: AXUIElement) -> AXUIElement? {
    if let focused = attr(app, "AXFocusedWindow") { return (focused as! AXUIElement) }
    return (attr(app, kAXWindowsAttribute as String) as? [AXUIElement])?.first
}

@discardableResult
func awaitStableTree(_ app: AXUIElement, timeoutMs: Int = 4000, quietMs: Int = 250) -> Bool {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
    var previous = -1

    while Date() < deadline {
        guard let window = focusedWindow(app) else { return false }
        let size = treeSize(window)

        if size == previous && size > 1 { return true }
        previous = size

        enableWebAccessibility(app)
        usleep(UInt32(quietMs) * 1000)
    }
    return false
}


struct Seen {
    let ref: String
    let element: AXUIElement
}

var refs: [String: AXUIElement] = [:]

struct Element {
    var ref: String
    var role: String
    var axRole: String
    var name: String
    var value: String?
    var url: String?
    var secure: Bool
    var disabled: Bool
    var focused: Bool
    var frame: CGRect
}

func observe(appName: String, maxElements: Int) -> [String: Any] {
    guard let running = application(named: appName) else {
        return ["error": "\(appName) is not running"]
    }

    let app = AXUIElementCreateApplication(running.processIdentifier)
    enableWebAccessibility(app)
    awaitStableTree(app)

    var target = focusedWindow(app)
    if target == nil {
        if present(appName) == nil { target = focusedWindow(app) }
    }
    guard let target else { return ["error": "\(appName) has no window to look at"] }

    var found: [Element] = []
    var pageUrl: String? = nil
    var pageTitle = text(target, kAXTitleAttribute as String) ?? ""
    var counter = 0
    var visited = 0

    func walk(_ element: AXUIElement, _ depth: Int, insideWeb: Bool) {
        if visited > 12000 || found.count >= maxElements || depth > 60 { return }
        visited += 1

        let axRole = text(element, kAXRoleAttribute as String) ?? "?"
        let subrole = text(element, kAXSubroleAttribute as String)
        var web = insideWeb

        if axRole == "AXWebArea" {
            web = true
            if pageUrl == nil { pageUrl = text(element, "AXURL") }
            if let t = text(element, kAXTitleAttribute as String), !t.isEmpty { pageTitle = t }
        }

        let box = rect(element)
        let visible = (box?.width ?? 0) >= 2 && (box?.height ?? 0) >= 2

        if visible, web, ACTIONABLE.contains(axRole) || READABLE.contains(axRole) {
            let label = name(element)
            if !label.isEmpty {
                counter += 1
                let ref = "a\(counter)"
                refs[ref] = element
                found.append(Element(
                    ref: ref,
                    role: webRole(axRole, subrole),
                    axRole: axRole,
                    name: String(label.prefix(120)),
                    value: text(element, kAXValueAttribute as String).map { String($0.prefix(80)) },
                    url: text(element, "AXURL"),
                    secure: subrole == "AXSecureTextField",
                    disabled: bool(element, kAXEnabledAttribute as String).map { !$0 } ?? false,
                    focused: bool(element, kAXFocusedAttribute as String) ?? false,
                    frame: box ?? .zero
                ))
            }
        }

        for child in kids(element) { walk(child, depth + 1, insideWeb: web) }
    }

    refs.removeAll()
    walk(target, 0, insideWeb: false)

    return [
        "url": pageUrl ?? "",
        "title": pageTitle,
        "app": appName,
        "visited": visited,
        "elements": found.map { element in
            var out: [String: Any] = [
                "ref": element.ref, "role": element.role, "axRole": element.axRole,
                "name": element.name,
                "x": Int(element.frame.midX), "y": Int(element.frame.midY),
                "w": Int(element.frame.width), "h": Int(element.frame.height)
            ]
            if let v = element.value, v != element.name { out["value"] = v }
            if let u = element.url { out["href"] = u }
            if element.secure { out["sensitive"] = "password" }
            if element.disabled { out["disabled"] = true }
            if element.focused { out["focused"] = true }
            return out
        }
    ]
}


func windowOwner(at point: CGPoint) -> pid_t? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
        as? [[String: Any]] else { return nil }

    for window in list {
        guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
              let owner = window[kCGWindowOwnerPID as String] as? pid_t,
              let x = bounds["X"], let y = bounds["Y"],
              let width = bounds["Width"], let height = bounds["Height"] else { continue }
        if CGRect(x: x, y: y, width: width, height: height).contains(point) { return owner }
    }
    return nil
}

func focusedApplication() -> pid_t? {
    let system = AXUIElementCreateSystemWide()
    for attempt in 0..<2 {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &value)
            == .success, let element = value {
            var pid: pid_t = 0
            if AXUIElementGetPid(element as! AXUIElement, &pid) == .success { return pid }
        }
        if attempt == 0 { usleep(50_000) }
    }
    return nil
}

func anyWindowOnScreen(_ pid: pid_t) -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
        as? [[String: Any]] else { return false }
    return list.contains { window in
        (window[kCGWindowOwnerPID as String] as? pid_t) == pid
            && (window[kCGWindowLayer as String] as? Int) == 0
    }
}

@discardableResult
func present(_ appName: String, timeoutMs: Int = 12000) -> String? {
    guard let running = application(named: appName) else { return "\(appName) is not running" }

    if running.isHidden { running.unhide() }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    var windows = (attr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []

    if windows.isEmpty {
        // A windowless app can take well over the old 3s to raise its first
        // window from cold (Chrome especially); give it the whole budget.
        reopen(appName)
        let windowDeadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        var renudged = false
        while windows.isEmpty && Date() < windowDeadline {
            usleep(150_000)
            windows = (attr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
            if windows.isEmpty && !renudged
                && Date().timeIntervalSince(windowDeadline) > -(Double(timeoutMs) / 2000) {
                renudged = true
                reopen(appName)
            }
        }
        if windows.isEmpty { return "\(appName) is running but has no window, and would not open one" }
    }

    for window in windows {
        if bool(window, kAXMinimizedAttribute as String) == true {
            AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        }
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
    var asked = Date.distantPast
    var escalated = false
    while Date() < deadline {
        if focusedApplication() == running.processIdentifier { return nil }
        if Date().timeIntervalSince(asked) > 0.7 {
            running.activate()
            asked = Date()
        }
        if !escalated && Date().timeIntervalSince(deadline) > -(Double(timeoutMs) / 1000 - 2.0) {
            escalated = true
            reopen(appName)
        }
        usleep(100_000)
    }

    if !anyWindowOnScreen(running.processIdentifier) {
        return "\(appName) has no window on screen — it is minimised, closed, or on another desktop, "
            + "and clicking where its window would be would land in another application"
    }
    return "\(appName) would not come to the front — something else is holding focus"
}

func frontmost(_ appName: String, timeoutMs: Int = 2000) -> Bool {
    guard let running = application(named: appName) else { return false }
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
    while Date() < deadline {
        if focusedApplication() == running.processIdentifier { return true }
        usleep(80_000)
    }
    return focusedApplication() == running.processIdentifier
}

func clickAt(_ point: CGPoint, in appName: String? = nil) -> String? {
    if let wanted = appName {
        if let why = present(wanted) { return why }
        guard let running = application(named: wanted) else { return "\(wanted) is not running" }
        _ = frontmost(wanted)

        if let owner = windowOwner(at: point), owner != running.processIdentifier {
            let other = NSRunningApplication(processIdentifier: owner)?.localizedName ?? "another application"
            return "that point on screen belongs to \(other), not to \(wanted) — the click was not made"
        }
    }

    let source = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
                       mouseCursorPosition: point, mouseButton: .left)
    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
                     mouseCursorPosition: point, mouseButton: .left)
    let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                       mouseCursorPosition: point, mouseButton: .left)
    for event in [move, down, up] { event?.flags = [] }
    move?.post(tap: .cghidEventTap)
    usleep(30_000)
    down?.post(tap: .cghidEventTap)
    usleep(20_000)
    up?.post(tap: .cghidEventTap)
    return nil
}

func exists(ref: String) -> [String: Any] {
    guard let element = refs[ref] else { return ["exists": false] }
    guard let role = text(element, kAXRoleAttribute as String) else { return ["exists": false] }
    let box = rect(element)
    return ["exists": true, "role": role,
            "onscreen": (box?.width ?? 0) >= 1 && (box?.height ?? 0) >= 1]
}

func press(ref: String, app appName: String) -> [String: Any] {
    guard let element = refs[ref] else { return ["error": "no element \(ref) — observe again"] }

    if let box = rect(element), box.width >= 1, box.height >= 1 {
        if let why = clickAt(CGPoint(x: box.midX, y: box.midY), in: appName) {
            return ["error": why]
        }
        return ["ok": true, "how": "click", "x": Int(box.midX), "y": Int(box.midY)]
    }
    if actions(element).contains(kAXPressAction as String),
       AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
        return ["ok": true, "how": "AXPress"]
    }
    return ["error": "element \(ref) cannot be pressed and has no position to click"]
}

func typeText(_ value: String) {
    let source = CGEventSource(stateID: .combinedSessionState)
    for chunk in value.chunked(20) {
        var utf16 = Array(chunk.utf16)
        let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
        down?.flags = []
        down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        up?.flags = []
        up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up?.post(tap: .cghidEventTap)
        usleep(12_000)
    }
}

extension String {
    func chunked(_ size: Int) -> [String] {
        var out: [String] = []
        var current = ""
        for character in self {
            current.append(character)
            if current.count >= size { out.append(current); current = "" }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }
}

let KEYCODES: [String: CGKeyCode] = [
    "Return": 36, "Tab": 48, "Space": 49, "Delete": 51, "Escape": 53,
    "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
    "ForwardDelete": 117,
    "L": 37, "T": 17, "W": 13, "A": 0
]

func pressKey(_ keyName: String, command: Bool = false) -> Bool {
    guard let code = KEYCODES[keyName] else { return false }
    let source = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    down?.flags = command ? .maskCommand : []
    up?.flags = command ? .maskCommand : []
    down?.post(tap: .cghidEventTap)
    usleep(20_000)
    up?.post(tap: .cghidEventTap)
    if command { usleep(60_000) }
    return true
}

func fill(ref: String, value: String, app appName: String) -> [String: Any] {
    guard let element = refs[ref] else { return ["error": "no element \(ref) — observe again"] }

    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(60_000)
    if !(bool(element, kAXFocusedAttribute as String) ?? false), let box = rect(element) {
        if let why = clickAt(CGPoint(x: box.midX, y: box.midY), in: appName) { return ["error": why] }
        usleep(120_000)
    }

    guard frontmost(appName) else {
        return ["error": "\(appName) is not the frontmost application — typing would go somewhere else"]
    }

    _ = pressKey("A", command: true)
    usleep(60_000)
    typeText(value)
    usleep(150_000)

    let landed = text(element, kAXValueAttribute as String) ?? ""
    if landed.contains(value) || value.contains(landed), !landed.isEmpty {
        return ["ok": true, "how": "typed"]
    }

    var settable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
    if settable.boolValue,
       AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef) == .success {
        return ["ok": true, "how": "AXValue"]
    }
    return ["error": "\(ref) did not take the text — it is not a field that can be typed into"]
}

func activate(app appName: String) -> [String: Any] {
    if let running = application(named: appName) {
        if let why = present(appName) { return ["error": why] }
        return ["ok": true, "launched": false, "pid": running.processIdentifier]
    }
    guard reopen(appName) else { return ["error": "could not launch \(appName)"] }

    for _ in 0..<40 {
        usleep(250_000)
        guard let running = application(named: appName) else { continue }
        if let why = present(appName) { return ["error": why] }
        return ["ok": true, "launched": true, "pid": running.processIdentifier]
    }
    return ["error": "\(appName) did not start"]
}

func addressBar(_ appName: String) -> String? {
    guard let running = application(named: appName) else { return nil }
    let app = AXUIElementCreateApplication(running.processIdentifier)

    func search(_ element: AXUIElement, _ depth: Int) -> String? {
        if depth > 8 { return nil }
        if (text(element, kAXRoleAttribute as String) ?? "").contains("TextField"),
           (text(element, kAXDescriptionAttribute as String) ?? "").contains("Address") {
            return text(element, kAXValueAttribute as String) ?? ""
        }
        for child in (attr(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] {
            if let found = search(child, depth + 1) { return found }
        }
        return nil
    }
    for window in (attr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] {
        if let found = search(window, 0) { return found }
    }
    return nil
}

func navigate(_ url: String, app appName: String) -> [String: Any] {
    let ready = activate(app: appName)
    if ready["error"] != nil { return ready }

    guard frontmost(appName) else {
        return ["error": "\(appName) is not the frontmost application — the address would be typed elsewhere"]
    }
    guard pressKey("L", command: true) else { return ["error": "no key for the address bar"] }
    usleep(150_000)
    typeText(url)
    usleep(200_000)

    _ = pressKey("ForwardDelete")
    usleep(120_000)

    let typed = (addressBar(appName) ?? "").trimmingCharacters(in: .whitespaces)
    guard typed == url || typed == url.replacingOccurrences(of: "https://", with: "") else {
        return ["error": "the address bar holds \"\(typed)\", not the address asked for — "
            + "the browser did not take the keystrokes"]
    }
    _ = pressKey("Return")
    usleep(400_000)
    return ["ok": true, "url": url]
}


func dump(appName: String, limit: Int) -> [String: Any] {
    guard let running = application(named: appName) else {
        return ["error": "\(appName) is not running"]
    }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    enableWebAccessibility(app)

    var lines: [String] = []
    var counts: [String: Int] = [:]
    var visited = 0

    func walk(_ element: AXUIElement, _ depth: Int) {
        if visited > 8000 || depth > 60 { return }
        visited += 1
        let role = text(element, kAXRoleAttribute as String) ?? "?"
        counts[role, default: 0] += 1
        if lines.count < limit {
            let label = name(element)
            var line = String(repeating: "  ", count: min(depth, 14)) + role
            if let sub = text(element, kAXSubroleAttribute as String) { line += "[\(sub)]" }
            if !label.isEmpty { line += " \"\(label.prefix(70))\"" }
            if let u = text(element, "AXURL") { line += " <\(u.prefix(60))>" }
            lines.append(line)
        }
        for child in kids(element) { walk(child, depth + 1) }
    }
    walk(app, 0)

    return ["visited": visited, "tree": lines,
            "roles": counts.sorted { $0.value > $1.value }.prefix(20)
                .map { "\($0.key)=\($0.value)" }]
}

func probe(appName: String, matching: String, limit: Int) -> [String: Any] {
    guard let running = application(named: appName) else {
        return ["error": "\(appName) is not running"]
    }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    enableWebAccessibility(app)
    awaitStableTree(app)
    guard let target = focusedWindow(app) else { return ["error": "no window"] }

    var out: [[String: Any]] = []
    var visited = 0

    func walk(_ element: AXUIElement, _ depth: Int) {
        if visited > 12000 || depth > 60 || out.count >= limit { return }
        visited += 1

        if name(element).lowercased().contains(matching.lowercased()) {
            var names: CFArray?
            AXUIElementCopyAttributeNames(element, &names)
            var attributes: [String: String] = [:]
            for key in (names as? [String]) ?? [] {
                var settable: DarwinBoolean = false
                AXUIElementIsAttributeSettable(element, key as CFString, &settable)
                let value = attr(element, key)
                attributes[key] = String(describing: value ?? "nil" as CFTypeRef).prefix(70)
                    + (settable.boolValue ? "  [settable]" : "")
            }
            out.append([
                "role": text(element, kAXRoleAttribute as String) ?? "?",
                "name": name(element),
                "depth": depth,
                "actions": actions(element),
                "attributes": attributes
            ])
        }

        for child in kids(element) { walk(child, depth + 1) }
    }
    walk(target, 0)
    return ["visited": visited, "found": out]
}


func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func trusted(prompt: Bool) -> Bool {
    AXIsProcessTrustedWithOptions(
        [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
}

func handle(_ request: [String: Any]) -> [String: Any] {
    let cmd = (request["cmd"] as? String) ?? ""
    let app = (request["app"] as? String) ?? "Google Chrome"

    if cmd == "trust" { return ["trusted": trusted(prompt: (request["prompt"] as? Bool) ?? false)] }

    guard trusted(prompt: false) else {
        return ["error": "no accessibility permission",
                "fix": "System Settings > Privacy & Security > Accessibility, then add jarvis-ax"]
    }

    switch cmd {
    case "observe":  return observe(appName: app, maxElements: (request["max"] as? Int) ?? 80)
    case "has":      return exists(ref: (request["ref"] as? String) ?? "")
    case "click":    return press(ref: (request["ref"] as? String) ?? "", app: app)
    case "fill":     return fill(ref: (request["ref"] as? String) ?? "",
                                 value: (request["text"] as? String) ?? "", app: app)
    case "key":      guard frontmost(app) else {
                         return ["error": "\(app) is not the frontmost application — "
                                        + "the keystroke would go somewhere else"]
                     }
                     return pressKey((request["name"] as? String) ?? "",
                                     command: (request["command"] as? Bool) ?? false)
                            ? ["ok": true] : ["error": "unknown key"]
    case "navigate": return navigate((request["url"] as? String) ?? "", app: app)
    case "activate": return activate(app: app)
    case "dump":     return dump(appName: app, limit: (request["limit"] as? Int) ?? 200)
    case "probe":    return probe(appName: app,
                                  matching: (request["name"] as? String) ?? "",
                                  limit: (request["limit"] as? Int) ?? 4)
    default:         return ["error": "unknown command \"\(cmd)\""]
    }
}

let argv = Array(CommandLine.arguments.dropFirst())
if !argv.isEmpty {
    var request: [String: Any] = ["cmd": argv[0]]
    var index = 1
    while index + 1 < argv.count + 1 && index < argv.count {
        let key = argv[index].hasPrefix("--") ? String(argv[index].dropFirst(2)) : argv[index]
        let value = index + 1 < argv.count ? argv[index + 1] : ""
        request[key] = Int(value) ?? value
        index += 2
    }
    if argv[0] == "trust" { request["prompt"] = true }
    emit(handle(request))
    exit(0)
}

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    guard let data = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        emit(["error": "not JSON"])
        continue
    }
    emit(handle(request))
}
