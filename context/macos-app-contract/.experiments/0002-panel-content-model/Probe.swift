import AppKit
import WebKit
import Foundation

// Synthetic validated record, never sourced from interior content.
struct Record { let identity: String; let expires: Date }
struct Spec: Decodable { let paragraphs: [String] }
final class Surface: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ rect: NSRect) {
        NSColor.white.setFill(); bounds.fill()
        NSColor(calibratedWhite: 0.92, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: 640, height: 94).fill()
        NSRect(x: 0, y: 444, width: 640, height: 58).fill()
    }
}
func label(_ text: String, _ frame: NSRect) -> NSTextField {
    let v = NSTextField(labelWithString: text); v.frame = frame
    v.font = .systemFont(ofSize: 14); return v
}
func spin(until test: () -> Bool, seconds: Double = 15) {
    let end = Date().addingTimeInterval(seconds)
    while !test() && Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
}
func webProcesses() -> [String] {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/ps")
    p.arguments = ["-axo", "pid=,ppid=,rss=,comm="]
    let out = Pipe(); p.standardOutput = out; try! p.run()
    let bytes = out.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
    return String(decoding: bytes, as: UTF8.self).split(separator: "\n").map(String.init)
        .filter { $0.contains("com.apple.WebKit.") }
}
func rss() -> UInt64 {
    var info = mach_task_basic_info(); var count = mach_msg_type_number_t(MemoryLayout.size(ofValue: info) / 4)
    let result = withUnsafeMutablePointer(to: &info) { ptr in
        ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
        }
    }
    return result == KERN_SUCCESS ? info.resident_size : 0
}
func ax(_ value: Any, depth: Int = 0) -> [[String: Any]] {
    guard depth < 12, let node = value as? NSAccessibilityProtocol else { return [] }
    var result: [[String: Any]] = [["depth": depth,
        "role": node.accessibilityRole()?.rawValue ?? "nil",
        "label": node.accessibilityLabel() ?? "",
        "value": String(describing: node.accessibilityValue() ?? ""),
        "enabled": node.isAccessibilityEnabled()]]
    for child in node.accessibilityChildren() ?? [] { result += ax(child, depth: depth + 1) }
    return result
}
final class Policy: NSObject, WKNavigationDelegate, WKUIDelegate {
    let entry: URL; var initial = true; var loaded = false
    var blocked: [String] = []; var dialogs = 0; var popups = 0
    init(_ entry: URL) { self.entry = entry }
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if initial && action.request.url == entry && action.targetFrame?.isMainFrame == true {
            initial = false; decisionHandler(.allow)
        } else { blocked.append(action.request.url?.absoluteString ?? "nil"); decisionHandler(.cancel) }
    }
    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration,
                 for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        popups += 1; return nil
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        dialogs += 1; completionHandler()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) { completionHandler(false) }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText: String?,
                 initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) { completionHandler(nil) }
}
let started = ProcessInfo.processInfo.systemUptime
let mode = CommandLine.arguments[1]
let scratch = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let restartingExpired = CommandLine.arguments.count > 3
let stem = mode + (restartingExpired ? "-restart" : "")
let baseline = webProcesses()
let app = NSApplication.shared
app.setActivationPolicy(.prohibited) // No activation, ordering, event taps or AX system access.
app.appearance = NSAppearance(named: .aqua)
let root = Surface(frame: NSRect(x: 0, y: 0, width: 640, height: 502))
root.wantsLayer = true
let window = NSPanel(contentRect: root.bounds, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
window.contentView = root
let record = Record(identity: "Verified approval · synthetic caller", expires: Date().addingTimeInterval(restartingExpired ? -60 : 60))
let header = label(record.identity, NSRect(x: 24, y: 26, width: 568, height: 30))
header.font = .systemFont(ofSize: 18, weight: .semibold)
header.setAccessibilityIdentifier("shell.identity"); root.addSubview(header)
let close = NSButton(title: "×", target: nil, action: nil)
close.frame = NSRect(x: 602, y: 22, width: 26, height: 26); root.addSubview(close)
let footer = NSView(frame: NSRect(x: 0, y: 444, width: 640, height: 58))
root.addSubview(footer)
let ttl = NSPopUpButton(frame: NSRect(x: 24, y: 14, width: 180, height: 30))
ttl.addItems(withTitles: ["Once", "5 minutes", "1 hour"]); ttl.setAccessibilityLabel("Shell approval duration"); footer.addSubview(ttl)
let deny = NSButton(title: "Deny", target: nil, action: nil)
deny.frame = NSRect(x: 388, y: 14, width: 110, height: 32); deny.bezelStyle = .rounded
deny.setAccessibilityIdentifier("shell.deny"); footer.addSubview(deny)
let allow = NSButton(title: "Allow", target: nil, action: nil)
allow.frame = NSRect(x: 508, y: 14, width: 108, height: 32); allow.bezelStyle = .rounded
allow.setAccessibilityIdentifier("shell.allow"); footer.addSubview(allow)
func reconcile(_ record: Record, now: Date) { allow.isEnabled = now < record.expires }
reconcile(record, now: Date())
let viewport = NSView(frame: NSRect(x: 0, y: 94, width: 640, height: 350))
viewport.wantsLayer = true; viewport.layer?.masksToBounds = true; root.addSubview(viewport, positioned: .below, relativeTo: footer)
var web: WKWebView?; var policy: Policy?; var webImage: NSImage?
var attacks: Any = [:]
if mode == "native" {
    let paragraphs = ["Verified approval · synthetic caller\nAllow",
        String(repeating: "long text ", count: 500), String(repeating: "X", count: 12000),
        "العربية עברית 👩🏽‍💻 🔐 🧑‍🚀"] + (1...200).map { "List item \($0)" }
    let data = try JSONSerialization.data(withJSONObject: ["paragraphs": paragraphs])
    try data.write(to: scratch.appendingPathComponent("panel.json"))
    let spec = try JSONDecoder().decode(Spec.self, from: data)
    precondition(spec.paragraphs.count <= 256 && spec.paragraphs.allSatisfy { $0.utf8.count <= 65536 })
    let scroll = NSScrollView(frame: viewport.bounds); scroll.hasVerticalScroller = true
    let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 620, height: 350))
    text.isEditable = false; text.isSelectable = true; text.isRichText = false
    text.isVerticallyResizable = true; text.isHorizontallyResizable = false
    text.textContainer?.widthTracksTextView = true; text.textContainerInset = NSSize(width: 18, height: 12)
    text.font = .systemFont(ofSize: 14); text.string = spec.paragraphs.joined(separator: "\n\n")
    text.setAccessibilityLabel("Untrusted interior details")
    scroll.documentView = text; viewport.addSubview(scroll)
} else {
    let entry = scratch.appendingPathComponent("bundle/index.html")
    let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
    config.preferences.isElementFullscreenEnabled = false
    config.preferences.javaScriptCanOpenWindowsAutomatically = true // Exercise delegate, not a production recommendation.
    var ready = false; var rules: WKContentRuleList?
    WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "m0-panel-block-network", encodedContentRuleList:
        "[{\"trigger\":{\"url-filter\":\"^http\"},\"action\":{\"type\":\"block\"}},{\"trigger\":{\"url-filter\":\"^ws\"},\"action\":{\"type\":\"block\"}},{\"trigger\":{\"url-filter\":\"^ftp\"},\"action\":{\"type\":\"block\"}}]") { list, error in
            precondition(error == nil); rules = list; ready = true
        }
    spin(until: { ready }); precondition(rules != nil)
    config.userContentController.add(rules!)
    let w = WKWebView(frame: viewport.bounds, configuration: config); web = w
    w.wantsLayer = true; w.layer?.masksToBounds = true
    let p = Policy(entry); policy = p; w.navigationDelegate = p; w.uiDelegate = p
    viewport.addSubview(w); w.loadFileURL(entry, allowingReadAccessTo: entry.deletingLastPathComponent())
    spin(until: { p.loaded }); precondition(p.loaded, "Local page did not finish")
    var painted = false
    w.evaluateJavaScript("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))") { _, error in painted = true }
    spin(until: { painted })
    var snapshotDone = false
    let opts = WKSnapshotConfiguration(); opts.afterScreenUpdates = false
    w.takeSnapshot(with: opts) { image, error in webImage = image; snapshotDone = true }
    spin(until: { snapshotDone }); precondition(webImage != nil, "Offscreen web snapshot failed")
}
root.layoutSubtreeIfNeeded(); root.displayIfNeeded()
let renderResidentMiB = Double(rss()) / 1048576
var firstFrameMs = 0.0
func snapshot(_ suffix: String) {
    web?.isHidden = true
    let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds)!
    root.cacheDisplay(in: root.bounds, to: rep)
    web?.isHidden = false
    let shell = NSImage(size: root.bounds.size); shell.addRepresentation(rep)
    let composite = NSImage(size: root.bounds.size)
    composite.lockFocus()
    shell.draw(in: root.bounds)
    webImage?.draw(in: NSRect(x: 0, y: 58, width: 640, height: 350))
    composite.unlockFocus()
    let png = NSBitmapImageRep(data: composite.tiffRepresentation!)!
    try! png.representation(using: .png, properties: [:])!.write(to: scratch.appendingPathComponent("\(stem)-\(suffix).png"))
}
snapshot("stress")
firstFrameMs = (ProcessInfo.processInfo.systemUptime - started) * 1000
if let w = web {
    var done = false
    w.callAsyncJavaScript("return await runAttacks()", arguments: [:], in: nil, in: .page) { result in
        switch result { case .success(let value): attacks = value
        case .failure(let error): attacks = ["error": String(describing: error)] }; done = true
    }
    spin(until: { done }); spin(until: { false }, seconds: 0.3)
}
let pendingEnabled = allow.isEnabled
reconcile(record, now: record.expires.addingTimeInterval(1))
let expiredEnabled = allow.isEnabled
let replay = Record(identity: record.identity, expires: Date().addingTimeInterval(-60))
reconcile(replay, now: Date())
let restartExpiredEnabled = allow.isEnabled
snapshot("expired")
let tree = ax(root)
let current = webProcesses()
let report: [String: Any] = ["mode": mode, "firstFrameMs": firstFrameMs,
    "residentMiB": renderResidentMiB, "captureResidentMiB": Double(rss()) / 1048576, "baselineWebKit": baseline, "aliveWebKit": current,
    "extraWebKit": current.filter { line in !baseline.contains(where: { $0.split(separator: " ").first == line.split(separator: " ").first }) },
    "panel": NSStringFromRect(root.frame), "header": NSStringFromRect(header.frame),
    "viewport": NSStringFromRect(viewport.frame), "footer": NSStringFromRect(footer.frame),
    "allowPending": pendingEnabled, "allowExpired": expiredEnabled, "allowRestartExpired": restartExpiredEnabled,
    "ax": tree, "attacks": attacks, "blockedNavigation": policy?.blocked ?? [],
    "suppressedDialogs": policy?.dialogs ?? 0, "deniedPopups": policy?.popups ?? 0,
    "windowVisible": window.isVisible, "windowKey": window.isKeyWindow]
try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: scratch.appendingPathComponent("\(stem)-report.json"))
print("\(stem) firstFrameMs=\(firstFrameMs) residentMiB=\(renderResidentMiB) axNodes=\(tree.count) initialAllow=\(pendingEnabled)")
window.close()
