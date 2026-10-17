import AppKit

// Swift is limited to this disposable experiment: direct AppKit/SCK/AVFoundation
// interop avoids an additional bridge or shipping runtime in the Rust product.
final class PatternView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        // Four flat sRGB quadrants; capture checks interior pixels, never chrome.
        let colors: [NSColor] = [.red, .green, .blue, .white]
        for index in 0..<4 {
            colors[index].setFill()
            NSRect(x: CGFloat(index % 2) * bounds.width / 2,
                   y: CGFloat(index / 2) * bounds.height / 2,
                   width: bounds.width / 2, height: bounds.height / 2).fill()
        }
    }
}
final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var count = 0
    var button: NSButton!
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 640, height: 480),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Permissions Fixture 0"
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
        let pattern = PatternView(frame: NSRect(x: 0, y: 80, width: 640, height: 400))
        pattern.setAccessibilityElement(false)
        content.addSubview(pattern)
        button = NSButton(title: "Counter 0", target: self, action: #selector(increment))
        button.frame = NSRect(x: 220, y: 20, width: 200, height: 40)
        button.setAccessibilityIdentifier("experiment-counter")
        content.addSubview(button)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func increment() {
        count += 1
        button.title = "Counter \(count)"
        window.title = "Permissions Fixture \(count)"
    }
}
let app = NSApplication.shared
let delegate = Fixture()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
