// Guided permission onboarding panel for the Mac Permissions Host (issue #2033).
//
// Same-process AppKit UI loaded by the Rust host for `onboard --human-present`.
// Rust owns every check, the sealed policy, audit records and persistence of the
// latest outcomes; this file only renders rows, opens the exact System Settings
// pane URL Rust supplied, and asks Rust to check the row the human selected.
//
// Ground rules this file keeps:
// - No check runs at initialization. A check only follows a human `Grant…` press
//   (full, possibly prompting check once per row) or, for the single selected row
//   that is awaiting approval, a non-prompting readiness retry (`row + 10000`)
//   driven by app-activation signals and a conservative timer.
// - A row shows "Granted" only when Rust's callback reports `passed`. Opening a
//   pane, a drop, or app activation never implies a grant.
// - No Accessibility API, no screen capture, no Settings UI automation, and the
//   System Settings window is never moved. Placement reads public window-list
//   metadata (owner pid, layer, bounds) only.
// - Callbacks, timers and observers live exactly as long as the panel; nothing
//   calls back into Rust after close, and check calls are never reentrant.
//
// Preview: `swiftc -parse-as-library -D PREVIEW host/src/Onboarding.swift -o onboarding-preview`
// builds a standalone, visibly labelled preview with fake rows and a fake check.
// The preview never calls Rust, never opens System Settings and never offers an
// app bundle as a drag source. Production builds compile none of that code.

import AppKit

/// Rust check callback. `action` is a row index for the full (possibly prompting)
/// check, or `row + 10000` for a non-prompting readiness retry. Returns UTF-8 JSON
/// `{"status": "passed"|"action-required"|"failed", "detail": "…"}` that stays
/// valid only until the next call.
public typealias OnboardingCheckCallback = @convention(c) (UnsafeMutableRawPointer?, Int32) -> UnsafePointer<CChar>?

private let retryActionOffset: Int32 = 10_000

/// Categories whose Rust readiness retry deliberately never reports a change
/// (macOS gives no harmless non-prompting signal). They are only re-checked when
/// the human presses `Grant…` again.
private let manualRecheckCategories: Set<String> = ["automation", "system-audio"]

@_cdecl("permissions_onboarding_run")
public func permissionsOnboardingRun(
    _ rowsJSON: UnsafePointer<CChar>,
    _ appPath: UnsafePointer<CChar>,
    _ context: UnsafeMutableRawPointer?,
    _ check: OnboardingCheckCallback
) {
    precondition(Thread.isMainThread, "permissions_onboarding_run must be called on the main thread")
    let rows = String(cString: rowsJSON)
    let path = String(cString: appPath)
    MainActor.assumeIsolated {
        autoreleasepool {
            let controller = OnboardingController(rowsJSON: rows, appPath: path, context: context, check: check)
            controller.runUntilClosed()
        }
    }
}

// MARK: - Model

private struct OnboardingRow: Decodable {
    let category: String
    let target: String?
    let title: String
    let explanation: String
    let pane: String
    let state: String
    let detail: String?
}

private struct CheckResult: Decodable {
    let status: String
    let detail: String?
}

private enum RowStatus {
    case pending, passed, actionRequired, failed

    init(initial wire: String) {
        switch wire {
        case "passed": self = .passed
        case "action-required": self = .actionRequired
        case "failed": self = .failed
        default: self = .pending
        }
    }
}

private enum RowNotice {
    case openFailed(String)
    case preview(String)
    case paused
}

private struct RowModel {
    let row: OnboardingRow
    var status: RowStatus
    var detail: String
    var checking = false
    /// Selected row whose last check said action-required; eligible for retries.
    var awaiting = false
    /// The full (possibly prompting) check already ran once for this row.
    var prompted = false
    var notice: RowNotice?

    var autoRetries: Bool { !manualRecheckCategories.contains(row.category) }
}

private enum Layout {
    static let panelWidth: CGFloat = 460
    static let margin: CGFloat = 16
    static let groupInset: CGFloat = 4
    static let groupRadius: CGFloat = 11
    static let rowPadding: CGFloat = 12
    static let iconColumn: CGFloat = 22
    static let trailingColumn: CGFloat = 96
    static let columnGap: CGFloat = 10
    static var textWidth: CGFloat {
        panelWidth - margin * 2 - groupInset * 2 - rowPadding * 2 - iconColumn - trailingColumn - columnGap * 2
    }
    static let maxRowsHeight: CGFloat = 392
    static let settingsGap: CGFloat = 12
}

private enum Timing {
    /// Conservative readiness poll, only while the selected row awaits approval.
    static let retryInterval: TimeInterval = 4
    /// Minimum quiet time between the end of one check and an automatic retry.
    static let minRetryGap: TimeInterval = 1.5
    /// Automatic retries stop after this; a human `Grant…` resumes them.
    static let maxAwait: TimeInterval = 10 * 60
    /// Settings may still be launching; look for its window a few times.
    static let placementDelays: [TimeInterval] = [0.2, 0.6, 1.2, 2.0, 3.0]
}

// MARK: - Controller

@MainActor
private final class OnboardingController: NSObject, NSWindowDelegate {
    private let context: UnsafeMutableRawPointer?
    private let check: OnboardingCheckCallback
    private let appName: String
    private let dragURL: URL?
    private var rows: [RowModel] = []
    private var loadError: String?

    private let panel: OnboardingPanel
    private let rootStack = NSStackView()
    private let group = RoundedGroupView()
    private let scrollView = NSScrollView()
    private let rowsStack = NSStackView()
    private var scrollHeight: NSLayoutConstraint!
    private var rowViews: [RowView] = []
    private let progressLabel = NSTextField(labelWithString: "")
    private let hintLabel = NSTextField(wrappingLabelWithString: "")
    private let footer = NSStackView()
    private let completion = NSStackView()
    private let completionImage = NSImageView()
    private let completionLabel = NSTextField(wrappingLabelWithString: "")
    private let doneButton = NSButton(title: "Done", target: nil, action: nil)

    private var selected: Int?
    private var isChecking = false
    private var isClosed = false
    private var pendingClose = false
    private var lastCheckEnded: Date?
    private var awaitingSince: Date?
    private var retryTimer: Timer?
    private var activationObserver: NSObjectProtocol?
    private var placementWork: [DispatchWorkItem] = []
    private var usesModal = false
    private var announcedComplete = false

    init(rowsJSON: String, appPath: String, context: UnsafeMutableRawPointer?, check: OnboardingCheckCallback) {
        self.context = context
        self.check = check
        self.appName = Self.displayName(appPath: appPath)
        #if PREVIEW
        self.dragURL = nil
        #else
        self.dragURL = Self.draggableBundleURL(appPath: appPath)
        #endif
        self.panel = OnboardingPanel(
            contentRect: NSRect(x: 0, y: 0, width: Layout.panelWidth, height: 420),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()
        do {
            let decoded = try JSONDecoder().decode([OnboardingRow].self, from: Data(rowsJSON.utf8))
            rows = decoded.map { RowModel(row: $0, status: RowStatus(initial: $0.state), detail: $0.detail ?? "") }
        } catch {
            loadError = "The host sent a permission list this panel couldn’t read. Nothing was checked."
        }
        configurePanel()
        buildContent(appPath: appPath)
        refresh()
    }

    // MARK: Lifecycle

    func runUntilClosed() {
        let app = NSApplication.shared
        if app.activationPolicy() == .prohibited {
            _ = app.setActivationPolicy(.accessory)
        }
        installActivationObserver()
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        if app.isRunning {
            usesModal = true
            app.runModal(for: panel)
        } else {
            app.run()
        }
        teardown()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // A check holds the main thread; if a nested run loop delivers a close,
        // finish the check first so Rust records its outcome, then close.
        if isChecking {
            pendingClose = true
            return false
        }
        return true
    }

    func windowWillClose(_ notification: Notification) {
        guard !isClosed else { return }
        teardown()
        if usesModal {
            NSApplication.shared.stopModal()
        } else {
            let app = NSApplication.shared
            app.stop(nil)
            // `stop` takes effect after the next event; post one so `run` returns now.
            if let wake = NSEvent.otherEvent(
                with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0,
                windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0
            ) {
                app.postEvent(wake, atStart: false)
            }
        }
    }

    /// Idempotent: after this nothing can reach the Rust callback.
    private func teardown() {
        isClosed = true
        stopAwaiting()
        placementWork.forEach { $0.cancel() }
        placementWork.removeAll()
        if let observer = activationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            activationObserver = nil
        }
    }

    private func installActivationObserver() {
        // No public notification exists for TCC changes. App activation (the human
        // returning from System Settings, or Settings yielding focus) is the cue
        // to re-check the selected row, without prompting.
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.autoRetry()
            }
        }
    }

    // MARK: Actions

    @objc fileprivate func grantPressed(_ sender: NSButton) {
        let index = sender.tag
        guard !isClosed, !isChecking, rows.indices.contains(index), rows[index].status != .passed else { return }
        if let previous = selected, previous != index {
            rows[previous].awaiting = false
        }
        stopAwaiting()
        selected = index
        rows[index].notice = nil
        rowViews[index].scrollToVisible(rowViews[index].bounds)
        // Settings is a navigation aid, not evidence or a prerequisite. Keep
        // the fallback notice visible and check even when manual navigation is needed.
        _ = openPane(for: index)
        // Full check once per row; afterwards only readiness retries, except for
        // categories whose readiness retry is inert by design.
        let prompting = !rows[index].prompted || !rows[index].autoRetries
        rows[index].prompted = true
        beginCheck(row: index, prompting: prompting)
    }

    @objc fileprivate func openPanePressed(_ sender: NSButton) {
        let index = sender.tag
        guard !isClosed, !isChecking, rows.indices.contains(index) else { return }
        rows[index].notice = nil
        _ = openPane(for: index)
        refresh()
    }

    @objc private func donePressed(_ sender: Any?) {
        panel.performClose(sender)
    }

    // MARK: Opening System Settings

    private static func paneURL(_ string: String) -> URL? {
        guard let url = URL(string: string), url.scheme == "x-apple.systempreferences" else { return nil }
        return url
    }

    private func openPane(for index: Int) -> Bool {
        let row = rows[index].row
        guard let url = Self.paneURL(row.pane) else {
            rows[index].notice = .openFailed("No valid System Settings link for this permission. Open System Settings → Privacy & Security → \(row.title) yourself, then press Grant… again.")
            return false
        }
        #if PREVIEW
        rows[index].notice = .preview("Preview: would open \(url.absoluteString)")
        #else
        guard NSWorkspace.shared.open(url) else {
            rows[index].notice = .openFailed("System Settings didn’t open. Open Privacy & Security → \(row.title) yourself, then press Grant… again.")
            return false
        }
        #endif
        schedulePlacement()
        return true
    }

    // MARK: Checks

    private func beginCheck(row index: Int, prompting: Bool) {
        guard !isClosed, !isChecking, rows.indices.contains(index) else { return }
        isChecking = true
        rows[index].checking = true
        refresh()
        panel.displayIfNeeded()
        let action = prompting ? Int32(index) : Int32(index) + retryActionOffset
        // Yield one run-loop turn so "Checking…" paints before the synchronous
        // check (which may show a system prompt and take up to ~30 s).
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.performCheck(row: index, action: action)
            }
        }
    }

    private func performCheck(row index: Int, action: Int32) {
        if isClosed || pendingClose {
            isChecking = false
            if !isClosed { rows[index].checking = false }
            closeIfPending()
            return
        }
        let (status, detail) = invokeCheck(action)
        isChecking = false
        lastCheckEnded = Date()
        guard !isClosed else { return }
        rows[index].checking = false
        apply(status: status, detail: detail, to: index)
        refresh()
        closeIfPending()
    }

    private func closeIfPending() {
        guard pendingClose, !isClosed else { return }
        pendingClose = false
        panel.performClose(nil)
    }

    private func invokeCheck(_ action: Int32) -> (RowStatus, String) {
        guard let pointer = check(context, action) else {
            return (.failed, "The host returned no check result.")
        }
        // The buffer is only valid until the next call: copy it now.
        let data = Data(bytes: pointer, count: strlen(pointer))
        guard let result = try? JSONDecoder().decode(CheckResult.self, from: data) else {
            return (.failed, "The host returned an unreadable check result.")
        }
        let detail = result.detail ?? ""
        switch result.status {
        case "passed": return (.passed, detail)
        case "action-required": return (.actionRequired, detail)
        case "failed": return (.failed, detail)
        default: return (.failed, "Unrecognized check status “\(result.status)”. \(detail)")
        }
    }

    private func apply(status: RowStatus, detail: String, to index: Int) {
        let previous = rows[index].status
        rows[index].status = status
        rows[index].detail = detail
        let isSelected = selected == index
        switch status {
        case .actionRequired where isSelected:
            rows[index].awaiting = true
            if rows[index].autoRetries { startAwaiting() } else { stopAwaiting() }
        default:
            rows[index].awaiting = false
            if isSelected {
                stopAwaiting()
                selected = nil
            }
        }
        if status != previous {
            switch status {
            case .passed: announce("\(rows[index].row.title) granted")
            case .failed: announce("\(rows[index].row.title) check failed")
            default: break
            }
        }
    }

    private func startAwaiting() {
        if awaitingSince == nil { awaitingSince = Date() }
        guard retryTimer == nil else { return }
        let timer = Timer(timeInterval: Timing.retryInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.autoRetry()
            }
        }
        timer.tolerance = 1
        RunLoop.main.add(timer, forMode: .common)
        retryTimer = timer
    }

    private func stopAwaiting() {
        retryTimer?.invalidate()
        retryTimer = nil
        awaitingSince = nil
    }

    /// Non-prompting readiness retry for the selected row only.
    private func autoRetry() {
        guard !isClosed, !isChecking else { return }
        guard let index = selected, rows.indices.contains(index),
              rows[index].awaiting, rows[index].autoRetries, rows[index].status == .actionRequired
        else {
            stopAwaiting()
            return
        }
        if let since = awaitingSince, Date().timeIntervalSince(since) > Timing.maxAwait {
            rows[index].awaiting = false
            rows[index].notice = .paused
            stopAwaiting()
            refresh()
            return
        }
        if let last = lastCheckEnded, Date().timeIntervalSince(last) < Timing.minRetryGap { return }
        beginCheck(row: index, prompting: false)
    }

    private func announce(_ text: String) {
        NSAccessibility.post(
            element: panel, notification: .announcementRequested,
            userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue]
        )
    }

    // MARK: Placement beside System Settings

    private func schedulePlacement() {
        placementWork.forEach { $0.cancel() }
        placementWork.removeAll()
        for (attempt, delay) in Timing.placementDelays.enumerated() {
            let isLast = attempt == Timing.placementDelays.count - 1
            let item = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.placePanel(fallbackIfMissing: isLast)
                }
            }
            placementWork.append(item)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        }
    }

    private func placePanel(fallbackIfMissing: Bool) {
        guard !isClosed else { return }
        if let settings = SettingsWindowLocator.frontmostWindowFrame() {
            placementWork.forEach { $0.cancel() }
            placementWork.removeAll()
            move(to: frameBeside(settings))
        } else if fallbackIfMissing {
            placementWork.removeAll()
            move(to: fallbackFrame())
        }
    }

    /// Prefer the right of Settings, then the left; if neither fits, float over
    /// Settings' trailing edge. Settings itself is never moved.
    private func frameBeside(_ settings: NSRect) -> NSRect {
        let size = panel.frame.size
        let center = NSPoint(x: settings.midX, y: settings.midY)
        let screen = NSScreen.screens.first { $0.frame.contains(center) } ?? panel.screen ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return panel.frame }
        let gap = Layout.settingsGap
        let x: CGFloat
        if settings.maxX + gap + size.width <= visible.maxX {
            x = settings.maxX + gap
        } else if settings.minX - gap - size.width >= visible.minX {
            x = settings.minX - gap - size.width
        } else {
            x = visible.maxX - size.width - gap
        }
        let y = min(max(settings.maxY - size.height, visible.minY + gap), visible.maxY - size.height)
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }

    /// No Settings window metadata: keep to the right edge, vertically centred,
    /// leaving the usual centred Settings position clear.
    private func fallbackFrame() -> NSRect {
        let size = panel.frame.size
        guard let visible = (panel.screen ?? NSScreen.main)?.visibleFrame else { return panel.frame }
        return NSRect(
            x: visible.maxX - size.width - 24,
            y: visible.midY - size.height / 2,
            width: size.width, height: size.height
        )
    }

    private func move(to frame: NSRect) {
        guard frame != panel.frame else { return }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            panel.setFrame(frame, display: true)
        } else {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.25
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrame(frame, display: true)
            }
        }
    }

    // MARK: Building

    private func configurePanel() {
        panel.title = "Grant Permissions for \(appName)"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .utilityWindow
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.delegate = self
    }

    private func buildContent(appPath: String) {
        let material = NSVisualEffectView()
        material.material = .underWindowBackground
        material.blendingMode = .behindWindow
        material.state = .active
        panel.contentView = material

        rootStack.orientation = .vertical
        rootStack.alignment = .centerX
        rootStack.spacing = 12
        rootStack.edgeInsets = NSEdgeInsets(top: 34, left: Layout.margin, bottom: Layout.margin, right: Layout.margin)
        rootStack.translatesAutoresizingMaskIntoConstraints = false
        material.addSubview(rootStack)
        NSLayoutConstraint.activate([
            rootStack.topAnchor.constraint(equalTo: material.topAnchor),
            rootStack.leadingAnchor.constraint(equalTo: material.leadingAnchor),
            rootStack.trailingAnchor.constraint(equalTo: material.trailingAnchor),
            rootStack.bottomAnchor.constraint(equalTo: material.bottomAnchor),
            rootStack.widthAnchor.constraint(equalToConstant: Layout.panelWidth),
        ])

        let header = makeHeader()
        addFullWidth(header)
        rootStack.setCustomSpacing(14, after: header)

        let icon = IconDragView(image: Self.icon(appPath: appPath), fileURL: dragURL, appName: appName)
        rootStack.addArrangedSubview(icon)
        rootStack.setCustomSpacing(6, after: icon)
        let caption = NSTextField(labelWithString: dragCaption())
        caption.font = .systemFont(ofSize: 11)
        caption.textColor = .secondaryLabelColor
        caption.alignment = .center
        rootStack.addArrangedSubview(caption)
        rootStack.setCustomSpacing(14, after: caption)

        buildRows()
        addFullWidth(group)

        buildFooter()
        addFullWidth(footer)
        buildCompletion()
        addFullWidth(completion)
    }

    /// Constant width, not relative to the stack: NSStackView detaches hidden
    /// arranged views, which would drop constraints that reference the stack.
    private func addFullWidth(_ view: NSView) {
        rootStack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalToConstant: Layout.panelWidth - Layout.margin * 2).isActive = true
    }

    private func makeHeader() -> NSView {
        let lock = NSImageView(image: symbol("lock.fill", size: 10, weight: .medium) ?? NSImage())
        lock.contentTintColor = .tertiaryLabelColor
        let title = NSTextField(labelWithString: "Grant Permissions for \(appName)")
        title.font = .systemFont(ofSize: 12, weight: .medium)
        title.textColor = .secondaryLabelColor
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let stack = NSStackView(views: [lock, title, spacer])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 5
        #if PREVIEW
        stack.addArrangedSubview(PreviewBadge())
        #endif
        return stack
    }

    private func dragCaption() -> String {
        #if PREVIEW
        return "Preview — dragging the app is disabled"
        #else
        return dragURL == nil
            ? "Use + in System Settings to add \(appName) where needed"
            : "Drag this icon into the list in System Settings"
        #endif
    }

    private func buildRows() {
        group.translatesAutoresizingMaskIntoConstraints = false
        rowsStack.orientation = .vertical
        rowsStack.alignment = .centerX
        rowsStack.spacing = 0
        rowsStack.edgeInsets = NSEdgeInsets(top: Layout.groupInset, left: Layout.groupInset, bottom: Layout.groupInset, right: Layout.groupInset)
        rowsStack.translatesAutoresizingMaskIntoConstraints = false

        if let loadError {
            let message = NSTextField(wrappingLabelWithString: loadError)
            message.font = .systemFont(ofSize: 12)
            message.textColor = .systemRed
            message.preferredMaxLayoutWidth = Layout.panelWidth - Layout.margin * 4
            let wrapper = NSStackView(views: [message])
            wrapper.edgeInsets = NSEdgeInsets(top: 10, left: Layout.rowPadding, bottom: 10, right: Layout.rowPadding)
            rowsStack.addArrangedSubview(wrapper)
        }
        for (index, model) in rows.enumerated() {
            if index > 0 {
                let separator = NSBox()
                separator.boxType = .separator
                rowsStack.addArrangedSubview(separator)
                separator.widthAnchor.constraint(equalTo: rowsStack.widthAnchor, constant: -(Layout.groupInset + Layout.rowPadding) * 2).isActive = true
            }
            let view = RowView(index: index, row: model.row, target: self,
                               grant: #selector(grantPressed(_:)), open: #selector(openPanePressed(_:)))
            rowsStack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: rowsStack.widthAnchor, constant: -Layout.groupInset * 2).isActive = true
            rowViews.append(view)
        }

        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(rowsStack)
        scrollView.documentView = document
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        group.addSubview(scrollView)
        let clip = scrollView.contentView
        scrollHeight = scrollView.heightAnchor.constraint(equalToConstant: 120)
        NSLayoutConstraint.activate([
            rowsStack.topAnchor.constraint(equalTo: document.topAnchor),
            rowsStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            rowsStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            rowsStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            document.topAnchor.constraint(equalTo: clip.topAnchor),
            document.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            document.widthAnchor.constraint(equalTo: clip.widthAnchor),
            scrollView.topAnchor.constraint(equalTo: group.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: group.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: group.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: group.bottomAnchor),
            scrollHeight,
        ])
    }

    private func buildFooter() {
        progressLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        progressLabel.textColor = .secondaryLabelColor
        #if PREVIEW
        hintLabel.stringValue = "Preview build: no checks reach the host, System Settings is never opened, and states are simulated."
        #else
        hintLabel.stringValue = "You turn on each switch yourself. A row shows Granted only after its check confirms access. Closing keeps the latest results."
        #endif
        hintLabel.font = .systemFont(ofSize: 11)
        hintLabel.textColor = .tertiaryLabelColor
        hintLabel.isSelectable = false
        hintLabel.preferredMaxLayoutWidth = Layout.panelWidth - Layout.margin * 2
        footer.orientation = .vertical
        footer.alignment = .leading
        footer.spacing = 3
        footer.addArrangedSubview(progressLabel)
        footer.addArrangedSubview(hintLabel)
    }

    private func buildCompletion() {
        completionLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        completionLabel.isSelectable = false
        completionLabel.preferredMaxLayoutWidth = Layout.panelWidth - Layout.margin * 2 - 120
        completionLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        doneButton.target = self
        doneButton.action = #selector(donePressed(_:))
        doneButton.keyEquivalent = "\r"
        doneButton.bezelStyle = .rounded
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        completion.orientation = .horizontal
        completion.alignment = .centerY
        completion.spacing = 8
        completion.setViews([completionImage, completionLabel, spacer, doneButton], in: .leading)
        completion.isHidden = true
    }

    // MARK: Rendering

    private var isComplete: Bool {
        loadError == nil && rows.allSatisfy { $0.status == .passed }
    }

    private func refresh() {
        let complete = isComplete
        let interactive = !isChecking && !complete && !isClosed
        for (index, view) in rowViews.enumerated() {
            view.apply(rows[index], selected: selected == index, interactive: interactive, appName: appName)
        }

        let passed = rows.filter { $0.status == .passed }.count
        progressLabel.stringValue = "\(passed) of \(rows.count) granted"
        footer.isHidden = complete || loadError != nil
        completion.isHidden = !(complete || loadError != nil)
        if let _ = loadError {
            completionImage.image = symbol("exclamationmark.triangle.fill", size: 16, weight: .medium)
            completionImage.contentTintColor = .systemOrange
            completionLabel.stringValue = "Close and run onboarding again."
            doneButton.title = "Close"
        } else if complete {
            stopAwaiting()
            completionImage.image = symbol("checkmark.seal.fill", size: 18, weight: .medium)
            completionImage.contentTintColor = .systemGreen
            completionLabel.stringValue = rows.isEmpty
                ? "This host policy needs no permissions."
                : "All set — every permission is granted."
            doneButton.title = "Done"
            if !announcedComplete {
                announcedComplete = true
                announce(completionLabel.stringValue)
                panel.makeFirstResponder(doneButton)
            }
        }
        fitPanel()
    }

    private func fitPanel() {
        rowsStack.layoutSubtreeIfNeeded()
        let screenHeight = (panel.screen ?? NSScreen.main)?.visibleFrame.height ?? 800
        let maxHeight = max(160, min(Layout.maxRowsHeight, screenHeight - 300))
        scrollHeight.constant = min(rowsStack.fittingSize.height, maxHeight)
        rootStack.layoutSubtreeIfNeeded()
        let size = rootStack.fittingSize
        let old = panel.frame
        var frame = panel.frameRect(forContentRect: NSRect(origin: old.origin, size: size))
        frame.origin.y = old.maxY - frame.height
        if frame != old { panel.setFrame(frame, display: true) }
    }

    // MARK: Helpers

    private static func displayName(appPath: String) -> String {
        guard !appPath.isEmpty else {
            #if PREVIEW
            return "Preview Host"
            #else
            return "Permissions Host"
            #endif
        }
        if let bundle = Bundle(path: appPath),
           let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName")
               ?? bundle.object(forInfoDictionaryKey: "CFBundleName")) as? String,
           !name.isEmpty {
            return name
        }
        return (FileManager.default.displayName(atPath: appPath) as NSString).deletingPathExtension
    }

    private static func draggableBundleURL(appPath: String) -> URL? {
        guard !appPath.isEmpty else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: appPath, isDirectory: &isDirectory), isDirectory.boolValue else { return nil }
        return URL(fileURLWithPath: appPath, isDirectory: true)
    }

    private static func icon(appPath: String) -> NSImage {
        if !appPath.isEmpty, FileManager.default.fileExists(atPath: appPath) {
            return NSWorkspace.shared.icon(forFile: appPath)
        }
        return NSImage(named: NSImage.applicationIconName) ?? NSImage()
    }
}

// MARK: - System Settings window metadata

/// Reads only public window-list metadata (owner pid, layer, bounds). Window
/// titles and contents are never requested, so no Screen Recording grant is
/// needed and nothing in Settings is inspected or manipulated.
private enum SettingsWindowLocator {
    static let bundleIdentifier = "com.apple.systempreferences"

    /// Frontmost normal-layer System Settings window, in Cocoa screen coordinates.
    static func frontmostWindowFrame() -> NSRect? {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).map(\.processIdentifier))
        guard !pids.isEmpty,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let primary = NSScreen.screens.first
        else { return nil }
        for info in list { // front-to-back order
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
                  (info[kCGWindowLayer as String] as? Int) == 0,
                  let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                  bounds.width >= 240, bounds.height >= 200
            else { continue }
            // Quartz: origin top-left of the primary display, y down.
            return NSRect(x: bounds.minX, y: primary.frame.maxY - bounds.maxY, width: bounds.width, height: bounds.height)
        }
        return nil
    }
}

// MARK: - Views

private final class OnboardingPanel: NSPanel {
    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        performClose(sender)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           event.charactersIgnoringModifiers == "w" {
            performClose(nil)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private final class RoundedGroupView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { nil }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        guard let layer else { return }
        layer.cornerRadius = Layout.groupRadius
        layer.cornerCurve = .continuous
        layer.masksToBounds = true
        layer.borderWidth = 1
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer.backgroundColor = NSColor.labelColor.withAlphaComponent(0.045).cgColor
            layer.borderColor = NSColor.separatorColor.cgColor
        }
    }
}

#if PREVIEW
private final class PreviewBadge: NSTextField {
    init() {
        super.init(frame: .zero)
        stringValue = "PREVIEW"
        isEditable = false
        isSelectable = false
        isBordered = false
        drawsBackground = false
        font = .systemFont(ofSize: 9, weight: .bold)
        textColor = .white
        alignment = .center
        wantsLayer = true
        setAccessibilityLabel("Preview build")
    }

    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: NSSize {
        let base = super.intrinsicContentSize
        return NSSize(width: base.width + 10, height: base.height + 2)
    }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.cornerRadius = 4
        effectiveAppearance.performAsCurrentDrawingAppearance {
            self.layer?.backgroundColor = NSColor.systemOrange.cgColor
        }
    }
}
#endif

/// The host app icon. When a real `.app` path is available it is an
/// NSDraggingSource carrying that bundle's file URL, so the human can drop it
/// straight into a System Settings privacy list instead of using + and a picker.
private final class IconDragView: NSView, NSDraggingSource {
    private let image: NSImage
    private let fileURL: URL?
    private var mouseDownPoint: NSPoint?

    init(image: NSImage, fileURL: URL?, appName: String) {
        self.image = image
        self.fileURL = fileURL
        super.init(frame: NSRect(x: 0, y: 0, width: 72, height: 72))
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        if let fileURL {
            setAccessibilityLabel("\(appName) app icon. Drag it into the list in System Settings.")
            toolTip = fileURL.path
        } else {
            setAccessibilityLabel("\(appName) app icon")
        }
    }

    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: NSSize { NSSize(width: 72, height: 72) }

    // The panel moves by its background; the icon must start drags instead.
    override var mouseDownCanMoveWindow: Bool { fileURL == nil }

    override func draw(_ dirtyRect: NSRect) {
        image.draw(in: bounds.insetBy(dx: 4, dy: 4), from: .zero, operation: .sourceOver, fraction: 1)
    }

    override func resetCursorRects() {
        if fileURL != nil { addCursorRect(bounds, cursor: .openHand) }
    }

    override func mouseDown(with event: NSEvent) {
        guard fileURL != nil else { return super.mouseDown(with: event) }
        mouseDownPoint = convert(event.locationInWindow, from: nil)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let url = fileURL, let start = mouseDownPoint else { return super.mouseDragged(with: event) }
        let point = convert(event.locationInWindow, from: nil)
        guard hypot(point.x - start.x, point.y - start.y) > 3 else { return }
        mouseDownPoint = nil
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        item.setDraggingFrame(bounds.insetBy(dx: 4, dy: 4), contents: image)
        let session = beginDraggingSession(with: [item], event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
        session.draggingFormation = .none
    }

    override func mouseUp(with event: NSEvent) {
        mouseDownPoint = nil
        super.mouseUp(with: event)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? .copy : []
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        mouseDownPoint = nil
    }
}

/// Status is always symbol + text, never colour alone.
private struct RowStatusPresentation {
    let symbol: String?
    let color: NSColor
    let text: String
}

private final class RowView: NSView {
    private let titleText: String
    private let icon = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let linkButton: NSButton
    private let explanationLabel = NSTextField(wrappingLabelWithString: "")
    private let noticeLabel = NSTextField(wrappingLabelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let grantButton: NSButton
    private let spinner = NSProgressIndicator()
    private let statusImage = NSImageView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let statusStack = NSStackView()
    private var highlighted = false

    init(index: Int, row: OnboardingRow, target: AnyObject, grant: Selector, open: Selector) {
        titleText = row.title
        linkButton = NSButton(image: symbol("arrow.up.forward", size: 9, weight: .semibold) ?? NSImage(), target: target, action: open)
        grantButton = NSButton(title: "Grant…", target: target, action: grant)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        setAccessibilityRole(.group)

        icon.image = symbol(categorySymbol(row.category), size: 15, weight: .regular)
        icon.contentTintColor = .secondaryLabelColor
        icon.widthAnchor.constraint(equalToConstant: Layout.iconColumn).isActive = true

        titleLabel.stringValue = row.title
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.toolTip = row.title
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        linkButton.tag = index
        linkButton.isBordered = false
        linkButton.contentTintColor = .tertiaryLabelColor
        linkButton.toolTip = "Open in System Settings"
        linkButton.setAccessibilityLabel("Open \(row.title) in System Settings")

        let titleRow = NSStackView(views: [titleLabel, linkButton])
        titleRow.orientation = .horizontal
        titleRow.alignment = .centerY
        titleRow.spacing = 3

        for label in [explanationLabel, noticeLabel, detailLabel] {
            label.font = .systemFont(ofSize: 11)
            label.preferredMaxLayoutWidth = Layout.textWidth
        }
        explanationLabel.stringValue = row.explanation
        explanationLabel.textColor = .secondaryLabelColor
        explanationLabel.isSelectable = false
        noticeLabel.isSelectable = false
        noticeLabel.isHidden = true
        detailLabel.isHidden = true // selectable: worth copying into a report

        let text = NSStackView(views: [titleRow, explanationLabel, noticeLabel, detailLabel])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2
        let textWidth = text.widthAnchor.constraint(equalToConstant: Layout.textWidth)
        textWidth.priority = .init(999) // yields to legacy (non-overlay) scrollers
        textWidth.isActive = true

        grantButton.tag = index
        grantButton.bezelStyle = .rounded
        grantButton.controlSize = .small
        grantButton.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        grantButton.setAccessibilityLabel("Grant \(row.title)…")

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.usesThreadedAnimation = true // keeps spinning while a check holds the main thread
        NSLayoutConstraint.activate([
            spinner.widthAnchor.constraint(equalToConstant: 12),
            spinner.heightAnchor.constraint(equalToConstant: 12),
        ])
        statusLabel.font = .systemFont(ofSize: 11, weight: .medium)
        statusStack.setViews([spinner, statusImage, statusLabel], in: .leading)
        statusStack.orientation = .horizontal
        statusStack.alignment = .centerY
        statusStack.spacing = 4

        let trailing = NSStackView(views: [grantButton, statusStack])
        trailing.orientation = .vertical
        trailing.alignment = .trailing
        trailing.spacing = 5
        trailing.widthAnchor.constraint(equalToConstant: Layout.trailingColumn).isActive = true

        let content = NSStackView(views: [icon, text, trailing])
        content.orientation = .horizontal
        content.alignment = .top
        content.spacing = Layout.columnGap
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Layout.rowPadding),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Layout.rowPadding),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func apply(_ model: RowModel, selected: Bool, interactive: Bool, appName: String) {
        if highlighted != selected {
            highlighted = selected
            needsDisplay = true
        }

        let status: RowStatusPresentation?
        if model.checking {
            status = RowStatusPresentation(symbol: nil, color: NSColor.secondaryLabelColor, text: "Checking…")
        } else {
            switch model.status {
            case .pending:
                status = nil
            case .passed:
                status = RowStatusPresentation(symbol: "checkmark.circle.fill", color: NSColor.systemGreen, text: "Granted")
            case .actionRequired where model.awaiting && model.autoRetries:
                status = RowStatusPresentation(symbol: "hourglass", color: NSColor.systemOrange, text: "Waiting…")
            case .actionRequired:
                status = RowStatusPresentation(symbol: "exclamationmark.circle.fill", color: NSColor.systemOrange, text: "Not granted")
            case .failed:
                status = RowStatusPresentation(symbol: "xmark.octagon.fill", color: NSColor.systemRed, text: "Check failed")
            }
        }
        if let status {
            statusStack.isHidden = false
            statusLabel.stringValue = status.text
            statusLabel.textColor = status.color
            statusImage.image = status.symbol.flatMap { symbol($0, size: 11, weight: .semibold) }
            statusImage.contentTintColor = status.color
            statusImage.isHidden = status.symbol == nil
        } else {
            statusStack.isHidden = true
        }
        if model.checking { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }

        grantButton.isHidden = model.status == .passed || model.checking
        grantButton.isEnabled = interactive
        linkButton.isEnabled = interactive

        var notice: (String, NSColor)?
        switch model.notice {
        case .openFailed(let message)?: notice = (message, .systemRed)
        case .preview(let message)?: notice = (message, .secondaryLabelColor)
        case .paused?: notice = ("Stopped checking automatically. Press Grant… to check again.", .systemOrange)
        case nil:
            if model.awaiting && model.status == .actionRequired && !model.checking {
                let message = model.autoRetries
                    ? "Turn on \(appName) in System Settings. This row updates once its check confirms access."
                    : "Allow \(appName) in System Settings, then press Grant… again to confirm."
                notice = (message, NSColor.secondaryLabelColor)
            }
        }
        noticeLabel.isHidden = notice == nil
        if let notice {
            noticeLabel.stringValue = notice.0
            noticeLabel.textColor = notice.1
        }

        detailLabel.isHidden = model.detail.isEmpty
        detailLabel.stringValue = model.detail
        detailLabel.textColor = model.status == .failed ? .secondaryLabelColor : .tertiaryLabelColor

        setAccessibilityLabel("\(titleText): \(status?.text ?? "Not checked")")
    }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        guard let layer else { return }
        layer.cornerRadius = Layout.groupRadius - Layout.groupInset
        layer.cornerCurve = .continuous
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer.backgroundColor = self.highlighted
                ? NSColor.controlAccentColor.withAlphaComponent(0.12).cgColor
                : NSColor.clear.cgColor
        }
    }
}

private func categorySymbol(_ category: String) -> String {
    switch category {
    case "full-disk-access": return "externaldrive"
    case "screen-recording": return "rectangle.dashed.badge.record"
    case "system-audio": return "speaker.wave.2"
    case "accessibility": return "accessibility"
    case "microphone": return "mic"
    case "notifications": return "bell.badge"
    case "automation": return "gearshape.2"
    default: return "lock.shield"
    }
}

private func symbol(_ name: String, size: CGFloat, weight: NSFont.Weight) -> NSImage? {
    NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(.init(pointSize: size, weight: weight))
}

// MARK: - Preview

#if PREVIEW
// Fake check: never touches TCC, Rust or System Settings. Prompting actions
// report action-required; readiness retries pass on the second try; the
// system-audio row fails first and recovers on the next human Grant.
private var previewRetryCounts: [Int32: Int] = [:]
private var previewResultBuffer: UnsafeMutablePointer<CChar>?

private func previewCheck(_ context: UnsafeMutableRawPointer?, _ action: Int32) -> UnsafePointer<CChar>? {
    let prompting = action < retryActionOffset
    let row = prompting ? action : action - retryActionOffset
    Thread.sleep(forTimeInterval: prompting ? 1.2 : 0.4) // real checks block the main thread too
    let count = (previewRetryCounts[row] ?? 0) + 1
    previewRetryCounts[row] = count
    let json: String
    switch (row, prompting) {
    case (5, true) where count == 1:
        json = #"{"status":"failed","detail":"Preview: simulated check failure."}"#
    case (5, _), (6, _), (7, _):
        json = count >= 3
            ? #"{"status":"passed","detail":"Preview: simulated confirmation."}"#
            : #"{"status":"action-required","detail":"Preview: simulated — not granted yet."}"#
    case (_, true):
        json = #"{"status":"action-required","detail":"Preview: simulated — not granted yet."}"#
    default:
        json = count >= 3
            ? #"{"status":"passed","detail":"Preview: simulated confirmation."}"#
            : #"{"status":"action-required","detail":"Preview: simulated — not granted yet."}"#
    }
    free(previewResultBuffer)
    previewResultBuffer = strdup(json)
    return UnsafePointer(previewResultBuffer)
}

private let previewRows = #"""
[
  {"category":"full-disk-access","title":"Full Disk Access","explanation":"Lets the host read the configured protected sentinel and files you allow.","pane":"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles","state":"pending","detail":""},
  {"category":"screen-recording","title":"Screen Recording","explanation":"Capture and discard only this host’s synthetic red test window.","pane":"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture","state":"pending","detail":""},
  {"category":"accessibility","title":"Accessibility","explanation":"Read and discard the focused-application attribute without changing UI.","pane":"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility","state":"pending","detail":""},
  {"category":"microphone","title":"Microphone","explanation":"Make a short disposable test capture; no recording is retained.","pane":"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone","state":"action-required","detail":"Preview: last check found no access."},
  {"category":"notifications","title":"Notifications","explanation":"Lets the host post status notifications.","pane":"x-apple.systempreferences:com.apple.Notifications-Settings.extension","state":"passed","detail":"Preview: previously confirmed."},
  {"category":"system-audio","title":"System Audio Recording","explanation":"Lets the host capture audio played by other apps. Press Grant… again after allowing it.","pane":"x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture","state":"pending","detail":""},
  {"category":"automation","target":"com.apple.finder","title":"Automation — Finder","explanation":"Lets the host send Apple Events to Finder. Press Grant… again after allowing it.","pane":"x-apple.systempreferences:com.apple.preference.security?Privacy_Automation","state":"pending","detail":""},
  {"category":"automation","target":"com.apple.Music","title":"Automation — Music","explanation":"Lets the host send Apple Events to Music. Press Grant… again after allowing it.","pane":"x-apple.systempreferences:com.apple.preference.security?Privacy_Automation","state":"pending","detail":""},
  {"category":"automation","target":"com.example.broken","title":"Automation — Broken Link","explanation":"Shows how a missing System Settings link is reported.","pane":"","state":"pending","detail":""}
]
"""#

@main
private enum OnboardingPreview {
    static func main() {
        previewRows.withCString { rows in
            "".withCString { appPath in
                permissionsOnboardingRun(rows, appPath, nil, previewCheck)
            }
        }
    }
}
#endif
