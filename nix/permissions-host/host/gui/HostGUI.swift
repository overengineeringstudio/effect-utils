import AppKit

// Reviewed, statically linked GUI modules only. Module-internal APIs never enter
// the public operations socket. In particular this ABI cannot request a signature.
@MainActor
protocol HostGUIModule {
    func start() throws
    func stop()
}

@MainActor
private func registeredModules() -> [any HostGUIModule] {
    // Register concrete linked modules here, in source review, not in policy.
    []
}

// Fixed C ABI v1: no paths, payloads, keys, URLs or caller-selected callbacks.
// The callback only observes host shutdown; its context lives until this returns.
@_cdecl("permissions_host_gui_run_v1")
func permissionsHostGUIRun(
    _ shouldStop: @convention(c) (UnsafeMutableRawPointer?) -> Bool,
    _ context: UnsafeMutableRawPointer?
) -> Int32 {
    guard Thread.isMainThread else { return 1 }
    return MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let modules = registeredModules()
        var started: [any HostGUIModule] = []
        defer {
            for module in started.reversed() { module.stop() }
        }
        do {
            for module in modules {
                try module.start()
                started.append(module)
            }
        } catch {
            return 2
        }
        app.finishLaunching()
        while !shouldStop(context) {
            autoreleasepool {
                if let event = app.nextEvent(
                    matching: .any,
                    until: Date(timeIntervalSinceNow: 0.02),
                    inMode: .default,
                    dequeue: true
                ) {
                    app.sendEvent(event)
                }
                app.updateWindows()
            }
        }
        return 0
    }
}
