import AppKit
import ApplicationServices
import AVFoundation
import ScreenCaptureKit
import UserNotifications
import CryptoKit
import AudioToolbox
import Darwin
import Security

#if RELEASE_V2
let experimentRelease = "2"
#else
let experimentRelease = "1"
#endif

func controlManifest() throws -> [String: Any] {
    guard let path = option("--manifest"),
          let result = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any] else {
        throw ProbeFailure(status: "failed", message: "invalid control manifest")
    }
    return result
}

func sessionKind() -> String {
    var identifier: SecuritySessionId = 0
    var attributes = SessionAttributeBits(rawValue: 0)
    let status = SessionGetInfo(callerSecuritySession, &identifier, &attributes)
    // AuthSession.h flags, shared with the Rust host's session classifier.
    if status != errSecSuccess || attributes.rawValue & 0x0001 != 0 { return "no-session" }
    return attributes.rawValue & 0x0010 != 0 ? "gui" : "background-only"
}

// Disposable experiment only. Swift directly exposes AppKit/SCK async APIs;
// shipped host implementation remains Rust. No client-selected command/path/argv.
// Build with macOS 14+ SDK in Swift 5 language mode. Never run during preparation.
struct ProbeFailure: Error { let status: String; let message: String }
func refuse(_ message: String) throws -> Never { throw ProbeFailure(status: "permission-required", message: message) }
func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw ProbeFailure(status: "failed", message: message) }
}
func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
let fm = FileManager.default
let home = fm.homeDirectoryForCurrentUser
let state = home.appendingPathComponent(".local/state/permissions-host-experiment", isDirectory: true)
let documents = home.appendingPathComponent("Documents/permissions-host-experiment/fda", isDirectory: true)
let names = ["alpha.txt", "beta.txt", "gamma.bin"]
let seeds = [Data("permissions-host alpha\n".utf8), Data("permissions-host beta\n".utf8), Data((0..<4096).map { UInt8($0 % 251) })]
let fixtureID = "dev.overeng.permissions-host.fixture"
let targets = ["a": "com.apple.TextEdit", "b": "com.apple.Calculator"]
func fda() -> Bool {
    // The inherited probe.c gate never requests consent. ENOENT is NOT a grant.
    guard let directory = opendir(home.appendingPathComponent("Library/Safari").path) else { return false }
    closedir(directory)
    return true
}
func axGranted() -> Bool {
    AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary)
}
func automation(_ target: String, prompt: Bool = false) -> OSStatus {
    let descriptor = NSAppleEventDescriptor(bundleIdentifier: target)
    return AEDeterminePermissionToAutomateTarget(descriptor.aeDesc, AEEventClass(typeWildCard), AEEventID(typeWildCard), prompt)
}
func address(_ path: String) throws -> sockaddr_un {
    var value = sockaddr_un()
    value.sun_family = sa_family_t(AF_UNIX)
    try require(path.utf8.count < MemoryLayout.size(ofValue: value.sun_path), "socket path too long")
    withUnsafeMutableBytes(of: &value.sun_path) { bytes in
        bytes.initializeMemory(as: UInt8.self, repeating: 0)
        bytes.copyBytes(from: path.utf8)
    }
    return value
}
func connectSocket(_ path: String) throws -> Int32 {
    var value = try address(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    try require(fd >= 0, "socket failed")
    let rc = withUnsafePointer(to: &value) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    } }
    if rc != 0 { close(fd); throw ProbeFailure(status: "failed", message: "socket connection failed: \(errno)") }
    var noSignal: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    return fd
}

final class AudioSamples: NSObject, SCStreamOutput {
    private let lock = NSLock()
    private var count = 0
    private var real = 0.0
    private var imaginary = 0.0
    private var energy = 0.0
    private var invalid: String?
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sample),
              let format = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { return }
        lock.lock(); defer { lock.unlock() }
        let description = asbd.pointee
        guard description.mFormatID == kAudioFormatLinearPCM,
              description.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              description.mBitsPerChannel == 32 else { invalid = "expected float32 linear PCM"; return }
        var needed = 0
        var retained: CMBlockBuffer?
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &needed,
            bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: 0, blockBufferOut: nil)
        let memory = UnsafeMutableRawPointer.allocate(byteCount: max(needed, MemoryLayout<AudioBufferList>.size), alignment: 16)
        defer { memory.deallocate() }
        let list = memory.bindMemory(to: AudioBufferList.self, capacity: 1)
        let rc = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil,
            bufferListOut: list, bufferListSize: needed, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &retained)
        guard rc == noErr else { invalid = "audio buffer unavailable"; return }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        guard let first = buffers.first, let data = first.mData else { return }
        let samples = data.assumingMemoryBound(to: Float.self)
        let stride = max(1, Int(first.mNumberChannels))
        let frames = Int(first.mDataByteSize) / MemoryLayout<Float>.size / stride
        for frame in 0..<frames {
            let x = Double(samples[frame * stride])
            let angle = 2 * Double.pi * 1000 * Double(count) / description.mSampleRate
            real += x * cos(angle); imaginary -= x * sin(angle); energy += x * x; count += 1
        }
    }
    func result() throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        try require(invalid == nil, invalid ?? "audio format error")
        try require(count > 0 && energy > 0, "no system audio samples")
        let amplitude = 2 * hypot(real, imaginary) / Double(count)
        let rms = sqrt(energy / Double(count))
        let ratio = amplitude / (rms * sqrt(2))
        try require(ratio > 0.35, "captured audio lacks expected coherent 1 kHz peak")
        return ["samples": count, "frequencyHz": 1000, "amplitude": amplitude, "rms": rms, "coherence": ratio]
    }
}

@MainActor final class Host {
    let audit: FileHandle
    var worker: Process?
    var watchHandle: FileHandle?
    var watchBuffer = Data()
    var watchRoot: String?
    init() throws {
        let log = home.appendingPathComponent("Library/Logs/permissions-host-experiment/audit.jsonl")
        try fm.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if !fm.fileExists(atPath: log.path) { try Data().write(to: log, options: [.withoutOverwriting]); try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: log.path) }
        audit = try FileHandle(forWritingTo: log)
        try audit.seekToEnd()
        try fm.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    func helper(_ name: String) throws -> URL {
        let url = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/\(name)")
        // Seal-host rewrites Mach-O signatures, so pre-sign SHA values are
        // provenance only. The validated outer resource seal pins the final
        // helper bytes; its helper DR must have the host's team and fixed ID.
        var outer: SecStaticCode?
        try require(SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &outer) == errSecSuccess, "cannot inspect host signature")
        let strict = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)
        try require(SecStaticCodeCheckValidity(outer!, strict, nil) == errSecSuccess, "host resource seal invalid")
        var information: CFDictionary?
        try require(SecCodeCopySigningInformation(outer!, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess, "cannot inspect signing team")
        guard let team = (information as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String,
              !team.isEmpty, team.allSatisfy({ $0.isLetter || $0.isNumber }) else {
            throw ProbeFailure(status: "failed", message: "host lacks signing team")
        }
        var code: SecStaticCode?
        try require(SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, "cannot inspect helper")
        let expression = "anchor apple generic and identifier \"dev.overeng.permissions-host.experiment.\(name)\" and certificate leaf[subject.OU] = \"\(team)\""
        var requirement: SecRequirement?
        try require(SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess, "invalid helper requirement")
        try require(SecStaticCodeCheckValidity(code!, strict, requirement) == errSecSuccess, "pinned helper signature mismatch")
        return url
    }
    func run(_ name: String, _ args: [String], input: Data? = nil) async throws -> Data {
        let executable = try helper(name)
        // No shell, client argv, inherited configuration, or responsibility disclaimer.
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                do {
                    let process = Process()
                    process.executableURL = executable; process.arguments = args
                    process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin", "LANG": "C", "RESTIC_PASSWORD": "disposable-permissions-experiment"]
                    let output = Pipe(); process.standardOutput = output
                    // Bounded experiment errors go to host stderr, never another unread pipe.
                    process.standardError = FileHandle.standardError
                    if let input = input {
                        let pipe = Pipe(); process.standardInput = pipe
                        try process.run(); try pipe.fileHandleForWriting.write(contentsOf: input); try pipe.fileHandleForWriting.close()
                    } else { process.standardInput = FileHandle.nullDevice; try process.run() }
                    let data = output.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    try require(process.terminationStatus == 0, "\(name) exit \(process.terminationStatus)")
                    continuation.resume(returning: data)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    func permissions() async -> [String: Bool] {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return ["ScreenCapture": CGPreflightScreenCaptureAccess(), "Accessibility": axGranted(),
                "SystemPolicyAllFiles": fda(), "Microphone": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
                "AppleEventsA": automation(targets["a"]!) == noErr, "AppleEventsB": automation(targets["b"]!) == noErr,
                "Notifications": settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional]
    }
    func seed() throws -> [[String: Any]] {
        guard fda() else { try refuse("Full Disk Access") }
        try fm.createDirectory(at: documents, withIntermediateDirectories: true)
        var files = [[String: Any]]()
        for (name, bytes) in zip(names, seeds) {
            guard fda() else { try refuse("Full Disk Access") }
            let path = documents.appendingPathComponent(name)
            try bytes.write(to: path, options: .atomic)
            files.append(["name": name, "sha256": sha(bytes), "bytes": bytes.count])
        }
        return files
    }
    func screen() async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else { try refuse("Screen Recording") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.owningApplication?.bundleIdentifier == fixtureID && $0.title?.hasPrefix("Permissions Fixture ") == true }) else {
            throw ProbeFailure(status: "session-unavailable", message: "fixture window unavailable")
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration(); config.width = 640; config.height = 480
        config.showsCursor = false; config.ignoreShadowsSingleWindow = true
        guard CGPreflightScreenCaptureAccess() else { try refuse("Screen Recording") }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let width = image.width, height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let ok = bytes.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height)); return true
        }
        try require(ok, "image normalization failed")
        // CG bitmap origin may invert row order. Four interior sample colors must
        // match the known quadrant set with the same horizontal pairing.
        func pixel(_ x: Int, _ y: Int) -> [Int] {
            let i = (y * width + x) * 4
            return bytes[i..<i+3].map(Int.init)
        }
        let samples = [pixel(width / 4, height / 4), pixel(3 * width / 4, height / 4),
                       pixel(width / 4, 3 * height / 4), pixel(3 * width / 4, 3 * height / 4)]
        let expected = [[255,0,0], [0,255,0], [0,0,255], [255,255,255]]
        func matches(_ order: [Int]) -> Bool {
            zip(samples, order).allSatisfy { pair in zip(pair.0, expected[pair.1]).allSatisfy { abs($0 - $1) <= 12 } }
        }
        try require(matches([0,1,2,3]) || matches([2,3,0,1]), "fixture pattern mismatch")
        let output = state.appendingPathComponent("capture.png")
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw ProbeFailure(status: "failed", message: "PNG encoding failed") }
        try png.write(to: output, options: .atomic)
        return ["windowId": window.windowID, "width": width, "height": height, "sha256": sha(png),
                "pixelSHA256": sha(Data(bytes)), "patternMatched": true, "samples": samples, "path": output.path]
    }
    func audio() async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else { try refuse("Screen Recording") }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw ProbeFailure(status: "session-unavailable", message: "no display") }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration(); config.width = 16; config.height = 16
        config.capturesAudio = true; config.excludesCurrentProcessAudio = false
        config.sampleRate = 48000; config.channelCount = 1
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let samples = AudioSamples()
        try stream.addStreamOutput(samples, type: .audio, sampleHandlerQueue: DispatchQueue(label: "experiment.audio"))
        guard CGPreflightScreenCaptureAccess() else { try refuse("Screen Recording") }
        try await stream.startCapture()
        do {
            // Output audio has no TCC gate; all input is the SCK guarded stream.
            let engine = AVAudioEngine(); let player = AVAudioPlayerNode(); engine.attach(player)
            let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
            engine.connect(player, to: engine.mainMixerNode, format: format)
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 96000)!
            buffer.frameLength = 96000
            for i in 0..<96000 { buffer.floatChannelData![0][i] = Float(0.15 * sin(2 * Double.pi * 1000 * Double(i) / 48000)) }
            try engine.start()
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in continuation.resume() }
                player.play()
            }
            player.stop(); engine.stop()
            try await stream.stopCapture()
            return try samples.result()
        } catch { try? await stream.stopCapture(); throw error }
    }
    func ax() throws -> [String: Any] {
        guard axGranted() else { try refuse("Accessibility") }
        guard let application = NSRunningApplication.runningApplications(withBundleIdentifier: fixtureID).first else {
            throw ProbeFailure(status: "session-unavailable", message: "fixture app unavailable")
        }
        let root = AXUIElementCreateApplication(application.processIdentifier)
        func attribute(_ element: AXUIElement, _ name: CFString) throws -> CFTypeRef {
            guard axGranted() else { try refuse("Accessibility") }
            var value: CFTypeRef?
            let rc = AXUIElementCopyAttributeValue(element, name, &value)
            try require(rc == .success && value != nil, "AX read failed: \(rc.rawValue)")
            return value!
        }
        let windows = try attribute(root, kAXWindowsAttribute as CFString) as! [AXUIElement]
        guard let window = windows.first else { throw ProbeFailure(status: "session-unavailable", message: "fixture has no AX window") }
        let before = try attribute(window, kAXTitleAttribute as CFString) as! String
        func find(_ element: AXUIElement, depth: Int) throws -> AXUIElement? {
            if depth > 12 { return nil }
            let role = try attribute(element, kAXRoleAttribute as CFString) as? String
            if role == (kAXButtonRole as String),
               let title = try attribute(element, kAXTitleAttribute as CFString) as? String,
               title.hasPrefix("Counter ") { return element }
            guard axGranted() else { try refuse("Accessibility") }
            var children: CFTypeRef?
            let rc = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
            if rc == .noValue || rc == .attributeUnsupported { return nil }
            try require(rc == .success, "AX children read failed")
            for child in children as? [AXUIElement] ?? [] {
                if let found = try find(child, depth: depth + 1) { return found }
            }
            return nil
        }
        guard let button = try find(window, depth: 0) else { throw ProbeFailure(status: "failed", message: "counter button missing") }
        guard axGranted() else { try refuse("Accessibility") }
        try require(AXUIElementPerformAction(button, kAXPressAction as CFString) == .success, "AX press failed")
        let after = try attribute(window, kAXTitleAttribute as CFString) as! String
        try require(before != after, "counter title did not change")
        return ["before": before, "after": after, "fixturePid": application.processIdentifier]
    }
    func watchCommand(_ command: [Any]) throws -> [[String: Any]] {
        guard let handle = watchHandle else { throw ProbeFailure(status: "failed", message: "watchman not connected") }
        try handle.write(contentsOf: JSONSerialization.data(withJSONObject: command) + Data([10]))
        var results = [[String: Any]]()
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if let newline = watchBuffer.firstIndex(of: 10) {
                let line = watchBuffer.prefix(upTo: newline); watchBuffer.removeSubrange(...newline)
                guard let row = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { throw ProbeFailure(status: "failed", message: "invalid watchman JSON") }
                if let error = row["error"] as? String { throw ProbeFailure(status: "failed", message: error) }
                results.append(row)
                if row["subscription"] == nil { return results }
                continue
            }
            var descriptor = pollfd(fd: handle.fileDescriptor, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 250)
            if ready < 0 { throw ProbeFailure(status: "failed", message: "watchman poll failed") }
            if ready == 0 { continue }
            let chunk = handle.availableData
            try require(!chunk.isEmpty, "watchman disconnected")
            watchBuffer.append(chunk)
            try require(watchBuffer.count <= 1_048_576, "watchman frame too large")
        }
        throw ProbeFailure(status: "failed", message: "watchman response timeout")
    }
    func startWatchman() throws -> [[String: Any]] {
        if worker?.isRunning != true {
            try? watchHandle?.close(); watchHandle = nil; watchBuffer.removeAll()
            let process = Process(); process.executableURL = try helper("watchman")
            let socket = state.appendingPathComponent("watchman.sock").path
            // --foreground stays a directly owned, non-disclaimed child.
            process.arguments = ["--foreground", "--sockname", socket, "--statefile", state.appendingPathComponent("watchman.state").path,
                                 "--logfile", state.appendingPathComponent("watchman.log").path]
            process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin"]
            process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.standardError
            process.standardError = FileHandle.standardError
            try process.run(); worker = process
        }
        if watchHandle == nil {
            // Socket readiness polling is bounded; never use delay as proof of readiness.
            let deadline = Date().addingTimeInterval(5)
            while watchHandle == nil && Date() < deadline && worker?.isRunning == true {
                if let fd = try? connectSocket(state.appendingPathComponent("watchman.sock").path) {
                    watchHandle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
                } else { usleep(20_000) }
            }
            try require(watchHandle != nil, "watchman socket not ready")
        }
        let root = "/Users/Shared/permissions-host-experiment/watch"
        try fm.createDirectory(atPath: root, withIntermediateDirectories: true)
        let watched = try watchCommand(["watch-project", root])
        watchRoot = root
        let subscribed = try watchCommand(["subscribe", root, "permissions-experiment", ["fields": ["name", "exists", "new"], "expression": ["type", "f"]]])
        return watched + subscribed
    }
    func operation(_ request: [String: Any], id: String) async throws -> [String: Any] {
        guard let op = request["op"] as? String else { throw ProbeFailure(status: "invalid-request", message: "missing op") }
        let prompt = request["allowPrompt"] as? Bool ?? false
        let promptOps = ["automation.a.request", "automation.b.request", "microphone.request"]
        try require(!prompt || promptOps.contains(op), "allowPrompt is forbidden for this operation")
        switch op {
        case "status": return ["permissions": await permissions(), "automationTargets": targets, "fixtureBundleId": fixtureID, "experimentRelease": experimentRelease]
        case "fda.preflight": return ["granted": fda()]
        case "microphone.preflight":
            let value = AVCaptureDevice.authorizationStatus(for: .audio)
            return ["granted": value == .authorized, "authorizationStatus": value.rawValue]
        case "microphone.request":
            let before = AVCaptureDevice.authorizationStatus(for: .audio)
            if before == .notDetermined {
                guard prompt else { try refuse("Microphone; explicit --allow-prompt required") }
                _ = await AVCaptureDevice.requestAccess(for: .audio)
            }
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { try refuse("Microphone") }
            // Real microphone open is separately preflighted immediately beforehand.
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { try refuse("Microphone") }
            guard let device = AVCaptureDevice.default(for: .audio) else { throw ProbeFailure(status: "failed", message: "no microphone") }
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { try refuse("Microphone") }
            let input = try AVCaptureDeviceInput(device: device)
            let session = AVCaptureSession()
            try require(session.canAddInput(input), "microphone input unavailable")
            session.addInput(input)
            guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { try refuse("Microphone") }
            session.startRunning(); let running = session.isRunning; session.stopRunning()
            try require(running, "microphone session failed to start")
            return ["granted": true, "opened": true, "authorizationStatus": AVCaptureDevice.authorizationStatus(for: .audio).rawValue]
        case "automation.a.preflight", "automation.b.preflight", "automation.a.request", "automation.b.request":
            let target = targets[String(op.split(separator: ".")[1])]!
            let before = automation(target)
            if op.hasSuffix("preflight") { return ["granted": before == noErr, "osStatus": before, "target": target] }
            if before != noErr {
                guard prompt && before == OSStatus(errAEEventWouldRequireUserConsent) else { try refuse("Automation \(target), OSStatus \(before)") }
                let authorized = automation(target, prompt: true)
                guard authorized == noErr else { try refuse("Automation \(target), OSStatus \(authorized)") }
            }
            guard automation(target) == noErr else { try refuse("Automation \(target)") }
            let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEGetData),
                targetDescriptor: NSAppleEventDescriptor(bundleIdentifier: target), returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            // Fixed get-name AppleEvent object specifier, never client AppleScript.
            let object = NSAppleEventDescriptor.record()
            object.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(typeProperty)), forKeyword: AEKeyword(keyAEDesiredClass))
            object.setDescriptor(NSAppleEventDescriptor(enumCode: OSType(formPropertyID)), forKeyword: AEKeyword(keyAEKeyForm))
            object.setDescriptor(NSAppleEventDescriptor(typeCode: OSType(pName)), forKeyword: AEKeyword(keyAEKeyData))
            object.setDescriptor(NSAppleEventDescriptor.null(), forKeyword: AEKeyword(keyAEContainer))
            guard let specifier = object.coerce(toDescriptorType: OSType(typeObjectSpecifier)) else {
                throw ProbeFailure(status: "failed", message: "cannot encode fixed AppleEvent object specifier")
            }
            event.setParam(specifier, forKeyword: AEKeyword(keyDirectObject))
            guard automation(target) == noErr else { try refuse("Automation \(target)") }
            let reply = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: 10)
            if let code = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value, code != 0 {
                throw ProbeFailure(status: "failed", message: "AppleEvent reply error \(code)")
            }
            return ["granted": true, "target": target, "reply": reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue ?? ""]
        case "screen.capture": return try await screen()
        case "audio.capture": return try await audio()
        case "ax.probe": return try ax()
        case "notifications.provisional":
            let center = UNUserNotificationCenter.current()
            let before = await center.notificationSettings()
            guard before.authorizationStatus != .denied else { try refuse("Notifications") }
            // .provisional alone is explicitly non-interruptive; never request alert/sound/badge authorization.
            if before.authorizationStatus == .notDetermined {
                try require(try await center.requestAuthorization(options: [.provisional]), "provisional authorization refused")
            }
            let after = await center.notificationSettings()
            return ["granted": after.authorizationStatus == .provisional || after.authorizationStatus == .authorized, "authorizationStatus": after.authorizationStatus.rawValue]
        case "core.notify":
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            guard settings.authorizationStatus == .provisional || settings.authorizationStatus == .authorized else { try refuse("Notifications") }
            let content = UNMutableNotificationContent(); content.title = "Permissions Experiment: host notification"
            content.body = "Disposable host session evidence"; content.sound = nil
            let notificationId = "permissions-experiment-" + id
            let latest = await center.notificationSettings()
            guard latest.authorizationStatus == .provisional || latest.authorizationStatus == .authorized else { try refuse("Notifications") }
            try await center.add(UNNotificationRequest(identifier: notificationId, content: content, trigger: nil))
            return ["notificationId": notificationId, "submitted": true, "displayed": NSNull(), "authorizationStatus": latest.authorizationStatus.rawValue]
        case "private.seed": return ["files": try seed()]
        case "core.copy-allowlisted":
            if let source = request["sourceId"] as? String { try require(source == "experiment-docs", "sourceId not allowlisted") }
            guard fda() else { try refuse("Full Disk Access") }
            let staging = state.appendingPathComponent("staging/" + id, isDirectory: true)
            try fm.createDirectory(at: staging, withIntermediateDirectories: true)
            do {
                var files = [[String: Any]]()
                for name in names {
                    guard fda() else { try refuse("Full Disk Access") }
                    let data = try Data(contentsOf: documents.appendingPathComponent(name))
                    let output = staging.appendingPathComponent(name)
                    try data.write(to: output, options: .withoutOverwriting)
                    files.append(["name": name, "path": output.path, "sha256": sha(data), "bytes": data.count])
                }
                return ["sourceId": "experiment-docs", "staging": staging.path, "files": files]
            } catch { try? fm.removeItem(at: staging); throw error }
        case "private.experiment-restic-backup":
            guard fda() else { try refuse("Full Disk Access") }
            let repo = state.appendingPathComponent("restic").path
            if !fm.fileExists(atPath: repo + "/config") { _ = try await run("restic", ["--repo", repo, "init", "--json"]) }
            guard fda() else { try refuse("Full Disk Access") }
            let backup = try await run("restic", ["--repo", repo, "backup", documents.path, "--json", "--tag", "permissions-experiment"])
            guard fda() else { try refuse("Full Disk Access") }
            let check = try await run("restic", ["--repo", repo, "check", "--read-data", "--json"])
            var files = [[String: Any]]()
            for (name, expected) in zip(names, seeds) {
                guard fda() else { try refuse("Full Disk Access") }
                let dumped = try await run("restic", ["--repo", repo, "dump", "latest", documents.appendingPathComponent(name).path])
                try require(sha(dumped) == sha(expected), "restic dump hash mismatch: \(name)")
                files.append(["name": name, "sha256": sha(dumped), "bytes": dumped.count])
            }
            return ["backupJSONL": String(decoding: backup, as: UTF8.self), "checkJSONL": String(decoding: check, as: UTF8.self), "files": files]
        case "watchman.start": return ["responses": try startWatchman(), "workerPid": worker!.processIdentifier]
        case "watchman.reconnect":
            try? watchHandle?.close(); watchHandle = nil; watchBuffer.removeAll()
            return ["responses": try startWatchman(), "workerPid": worker!.processIdentifier]
        case "watchman.events":
            _ = try startWatchman()
            let root = watchRoot!
            let marker = URL(fileURLWithPath: root).appendingPathComponent("event-" + id)
            try Data(id.utf8).write(to: marker)
            let clock = try watchCommand(["clock", root, ["sync_timeout": 5000]])
            let rows = try watchCommand(["query", root, ["expression": ["name", marker.lastPathComponent], "fields": ["name", "exists"]]])
            let found = rows.contains { row in (row["files"] as? [[String: Any]] ?? []).contains { $0["name"] as? String == marker.lastPathComponent } }
            try require(found, "watchman did not observe marker")
            return ["responses": clock + rows, "marker": marker.lastPathComponent, "workerPid": worker!.processIdentifier]
        case "watchman.fda":
            guard fda() else { try refuse("Full Disk Access") }
            _ = try startWatchman()
            guard fda() else { try refuse("Full Disk Access") }
            let watched = try watchCommand(["watch-project", documents.path])
            // Protected watches are scoped to this preflighted operation; never
            // leave a background worker crawling Documents after revocation.
            defer { _ = try? watchCommand(["watch-del", documents.path]) }
            guard fda() else { try refuse("Full Disk Access") }
            let rows = try watchCommand(["query", documents.path, ["fields": ["name", "exists"], "expression": ["type", "f"]]])
            let observed = Set(rows.flatMap { ($0["files"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String } })
            try require(Set(names).isSubset(of: observed), "watchman protected fixture files missing")
            return ["responses": watched + rows, "workerPid": worker!.processIdentifier]
        case "watchman.stop":
            try? watchHandle?.close(); watchHandle = nil
            if worker?.isRunning == true { worker?.terminate() }
            return ["stopped": true]
        default: throw ProbeFailure(status: "invalid-request", message: "unknown operation")
        }
    }
    func respond(_ data: Data, peer: [String: Any]) async -> Data {
        let id = UUID().uuidString
        var row: [String: Any] = ["auditId": id, "timestamp": ISO8601DateFormatter().string(from: Date()), "peer": peer, "hostPid": getpid()]
        do {
            guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw ProbeFailure(status: "invalid-request", message: "expected JSON object")
            }
            if request["action"] != nil {
                try require(request["wireVersion"] as? Int == 1 && request["action"] as? String == "status" &&
                            (request["args"] as? [String: Any])?.isEmpty == true, "unsupported control request")
                let manifest = try controlManifest()
                let allowed = manifest["statusAllowedUids"] as? [UInt32] ?? []
                try require(allowed.contains((peer["uid"] as? UInt32) ?? UInt32.max), "status caller not allowlisted")
                let sourceHash = try String(contentsOf: Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/source-hash"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
                guard let generation = manifest["generation"] as? String else { throw ProbeFailure(status: "failed", message: "missing generation") }
                row["wireVersion"] = 1; row["ok"] = true
                row["status"] = ["hostVersion": "1", "hostSourceHash": sourceHash, "generation": generation, "pid": getpid(), "session": sessionKind()]
                row["op"] = "ctl.status"; row["request"] = request
            } else {
            guard let op = request["op"] as? String else { throw ProbeFailure(status: "invalid-request", message: "missing op") }
            row["op"] = op; row["request"] = request
            // Persist intent before any API, including consent-waived calls.
            var intent = row; intent["phase"] = "begin"
            try audit.write(contentsOf: JSONSerialization.data(withJSONObject: intent, options: [.sortedKeys]) + Data([10]))
            try audit.synchronize()
            row["result"] = try await operation(request, id: id); row["status"] = "ok"
            }
        } catch let error as ProbeFailure { row["status"] = error.status; row["error"] = error.message
        } catch { row["status"] = "failed"; row["error"] = String(describing: error) }
        row["phase"] = "complete"
        do {
            let output = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) + Data([10])
            try audit.write(contentsOf: output); try audit.synchronize()
            return output
        } catch {
            // Audit failure is fatal: never continue unaudited work.
            fputs("audit persistence failed\n", stderr); exit(74)
        }
    }
}

let args = Array(CommandLine.arguments.dropFirst())
func option(_ key: String) -> String? { guard let i = args.firstIndex(of: key), i + 1 < args.count else { return nil }; return args[i+1] }
@main enum HostEntry {
@MainActor static func main() {
guard let socketPath = option("--socket") else { fputs("usage: host --socket PATH --manifest PATH\n", stderr); exit(64) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let host: Host
do { host = try Host() } catch { fputs("host initialization failed: \(error)\n", stderr); exit(78) }
DispatchQueue.global().async {
    do {
        let parent = URL(fileURLWithPath: socketPath).deletingLastPathComponent()
        try fm.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try fm.attributesOfItem(atPath: parent.path)
        try require((attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(), "socket directory owner mismatch")
        try require(((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0, "socket directory must be private")
        var value = try address(socketPath)
        // Remove only a stale socket owned by this uid, never an arbitrary file.
        if fm.fileExists(atPath: socketPath) {
            let old = try fm.attributesOfItem(atPath: socketPath)
            try require(old[.type] as? FileAttributeType == .typeSocket && (old[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(), "unsafe existing socket")
            try fm.removeItem(atPath: socketPath)
        }
        let server = socket(AF_UNIX, SOCK_STREAM, 0)
        try require(server >= 0, "socket failed")
        let bound = withUnsafePointer(to: &value) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        } }
        let manifest = try controlManifest()
        guard let mode = manifest["socketMode"] as? UInt32 else { throw ProbeFailure(status: "failed", message: "missing socketMode") }
        try require(mode == 0o600, "experiment requires socketMode 0600")
        try require(bound == 0 && chmod(socketPath, mode_t(mode)) == 0 && listen(server, 8) == 0, "bind/listen failed")
        while true {
            let client = accept(server, nil, nil)
            if client < 0 { if errno == EINTR { continue }; throw ProbeFailure(status: "failed", message: "accept failed") }
            var uid: uid_t = 0, gid: gid_t = 0, pid: pid_t = 0
            var size = socklen_t(MemoryLayout<pid_t>.size)
            guard getpeereid(client, &uid, &gid) == 0, uid == getuid(),
                  getsockopt(client, SOL_LOCAL, LOCAL_PEERPID, &pid, &size) == 0 else { close(client); continue }
            var noSignal: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            var timeout = timeval(tv_sec: 10, tv_usec: 0)
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            let handle = FileHandle(fileDescriptor: client, closeOnDealloc: true)
            var request = Data()
            do {
                while !request.contains(10) && request.count <= 65536 {
                    guard let chunk = try handle.read(upToCount: 4096), !chunk.isEmpty else { break }
                    request.append(chunk)
                }
                guard request.last == 10, request.count <= 65536,
                      request.dropLast().contains(10) == false else { try handle.close(); continue }
                let completion = DispatchSemaphore(value: 0)
                let peer: [String: Any] = ["uid": uid, "gid": gid, "pid": pid]
                Task { @MainActor in
                    let response = await host.respond(request, peer: peer)
                    try? handle.write(contentsOf: response); try? handle.close(); completion.signal()
                }
                completion.wait() // One operation at a time, bounded request admission.
            } catch { try? handle.close() }
        }
    } catch { fputs("socket server failed: \(error)\n", stderr); exit(71) }
}
app.run()
}
}
