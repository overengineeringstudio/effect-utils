import Foundation

/// Canonical component fields. Timestamps are Unix seconds, not milliseconds.
/// Source revisions are supplied provenance; this library never infers Git state.
public struct BuildStamp: Codable, Equatable, Sendable {
    public enum SourceKind: String, Codable, Sendable { case local, nix }
    public let baseVersion: String
    public let rev: String?
    public let dirty: Bool
    public let sourceKind: SourceKind
    public let commitTs: Double?
    public let buildTs: Double?

    public init(baseVersion: String, rev: String? = nil, dirty: Bool,
                sourceKind: SourceKind, commitTs: Double? = nil, buildTs: Double? = nil) {
        self.baseVersion = baseVersion; self.rev = rev; self.dirty = dirty
        self.sourceKind = sourceKind; self.commitTs = commitTs; self.buildTs = buildTs
    }

    private var revision: String? { rev.flatMap { $0.isEmpty ? nil : String($0.prefix(7)) } }

    public var machineVersion: String {
        baseVersion + (revision.map { "+\($0)" } ?? "") + (dirty ? "-dirty" : "")
    }

    public func displayVersion(now: Double) -> String {
        let dirtyNote = dirty ? ", with uncommitted changes" : ""
        if let commitTs {
            return "\(machineVersion) — committed \(formatRelativeTime(ts: commitTs, now: now, format: .long))" + dirtyNote
        }
        if sourceKind == .local {
            let age = buildTs.map { formatRelativeTime(ts: $0, now: now, format: .long) } ?? "n/a"
            return "\(baseVersion) — running from local source (\(revision ?? "n/a"), \(age))" + dirtyNote
        }
        return machineVersion
    }

    public func identity(now: Double) -> BuildIdentity {
        BuildIdentity(displayVersion: displayVersion(now: now), machineVersion: machineVersion,
                      dirty: dirty, rev: rev, commitTs: commitTs, buildTs: buildTs)
    }

    public func short(now: Double) -> String { identity(now: now).short(now: now) }
    public func details(now: Double) -> [BuildIdentityDetail] { identity(now: now).details(now: now) }
}

/// A resolved identity preserves supplied machine/display strings verbatim.
/// Human presentation never substitutes deployment age for unknown commit age.
public struct BuildIdentity: Codable, Equatable, Sendable {
    public let displayVersion: String
    public let machineVersion: String
    public let dirty: Bool
    public let rev: String?
    public let commitTs: Double?
    public let buildTs: Double?

    public init(displayVersion: String, machineVersion: String, dirty: Bool,
                rev: String? = nil, commitTs: Double? = nil, buildTs: Double? = nil) {
        self.displayVersion = displayVersion; self.machineVersion = machineVersion
        self.dirty = dirty; self.rev = rev; self.commitTs = commitTs; self.buildTs = buildTs
    }

    public func short(now: Double) -> String {
        let revision = rev.flatMap { $0.isEmpty ? nil : String($0.prefix(7)) } ?? "n/a"
        let age = commitTs.map { formatRelativeTime(ts: $0, now: now) } ?? "n/a"
        return "\(revision)\(dirty ? "*" : "") · \(age)"
    }

    public func details(now: Double) -> [BuildIdentityDetail] {
        var lines = [BuildIdentityDetail(label: "displayVersion", value: displayVersion),
                     BuildIdentityDetail(label: "machineVersion", value: machineVersion)]
        if let buildTs {
            let age = formatRelativeTime(ts: buildTs, now: now)
            lines.append(BuildIdentityDetail(label: "deployed", value: age == "n/a" ? age : "\(age) ago"))
        }
        return lines
    }
}

public struct BuildIdentityDetail: Codable, Equatable, Sendable {
    public let label: String
    public let value: String
    public init(label: String, value: String) { self.label = label; self.value = value }
}

public enum RelativeTimeFormat: Sendable { case short, long }

public func formatRelativeTime(ts: Double, now: Double, format: RelativeTimeFormat = .short) -> String {
    guard ts.isFinite, now.isFinite else { return "n/a" }
    let seconds = max(0, floor(now - ts))
    func count(_ unit: Double) -> String { String(format: "%.0f", floor(seconds / unit)) }
    if seconds < 60 { return format == .long ? "just now" : "\(count(1))s" }
    if seconds < 3_600 { return format == .long ? "\(count(60)) min ago" : "\(count(60))m" }
    if seconds < 86_400 {
        return format == .long ? "\(count(3_600)) \(floor(seconds / 3_600) == 1 ? "hour" : "hours") ago" : "\(count(3_600))h"
    }
    if format == .long {
        if seconds < 604_800 { return "\(count(86_400)) \(floor(seconds / 86_400) == 1 ? "day" : "days") ago" }
        if seconds < 2_592_000 { return "\(count(604_800)) \(floor(seconds / 604_800) == 1 ? "week" : "weeks") ago" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d"
        return formatter.string(from: Date(timeIntervalSince1970: ts))
    }
    if seconds < 2_592_000 { return "\(count(86_400))d" }
    if seconds < 31_536_000 { return "\(count(2_592_000))mo" }
    return "\(count(31_536_000))y"
}
