import Foundation

/// The existing CLI_BUILD_STAMP transport, separate from canonical bundle fields.
public enum CLIStamp: Equatable, Sendable, Decodable {
    case local(rev: String, ts: Double, dirty: Bool, commitTs: Double?)
    case nix(version: String, rev: String, commitTs: Double, dirty: Bool, buildTs: Double?)

    private enum Keys: String, CodingKey { case type, version, rev, ts, commitTs, dirty, buildTs }
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let type = try container.decode(String.self, forKey: .type)
        let rev = try container.decode(String.self, forKey: .rev)
        let dirty = try container.decode(Bool.self, forKey: .dirty)
        switch type {
        case "local":
            self = .local(rev: rev, ts: try container.decode(Double.self, forKey: .ts), dirty: dirty,
                          commitTs: try? container.decode(Double.self, forKey: .commitTs))
        case "nix":
            self = .nix(version: try container.decode(String.self, forKey: .version), rev: rev,
                        commitTs: try container.decode(Double.self, forKey: .commitTs), dirty: dirty,
                        buildTs: try? container.decode(Double.self, forKey: .buildTs))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown build stamp type")
        }
    }

    public static func parse(_ json: String) -> CLIStamp? {
        try? JSONDecoder().decode(Self.self, from: Data(json.utf8))
    }
}

extension BuildIdentity {
    /// Matches CLI resolution precedence: embedded Nix, runtime local/Nix, package.
    /// Time and environment are explicit for deterministic application composition.
    public static func resolveCLI(baseVersion: String, buildStamp: String,
                                  environment: [String: String] = ProcessInfo.processInfo.environment,
                                  now: Double, runtimeStampEnvVar: String = "CLI_BUILD_STAMP") -> BuildIdentity {
        let embedded = CLIStamp.parse(buildStamp)
        if let embedded, case .nix = embedded { return resolve(embedded, baseVersion: baseVersion, now: now) }
        if let raw = environment[runtimeStampEnvVar], let runtime = CLIStamp.parse(raw) {
            return resolve(runtime, baseVersion: baseVersion, now: now)
        }
        return BuildIdentity(displayVersion: baseVersion, machineVersion: baseVersion, dirty: false)
    }

    private static func resolve(_ stamp: CLIStamp, baseVersion: String, now: Double) -> BuildIdentity {
        switch stamp {
        case .local(let rev, let ts, let dirty, let commitTs):
            let age = commitTs.map { "committed " + formatRelativeTime(ts: $0, now: now, format: .long) }
                ?? formatRelativeTime(ts: ts, now: now, format: .long)
            let note = dirty ? ", with uncommitted changes" : ""
            return BuildIdentity(
                displayVersion: "\(baseVersion) — running from local source (\(rev), \(age)\(note))",
                machineVersion: "\(baseVersion)+local.\(rev)\(dirty ? ".dirty" : "")",
                dirty: dirty, rev: rev, commitTs: commitTs, buildTs: ts)
        case .nix(let version, let rev, let commitTs, let dirty, let buildTs):
            let machine = "\(version)+\(rev)" + (dirty && !rev.hasSuffix("-dirty") ? "-dirty" : "")
            let age = buildTs.map { "built " + formatRelativeTime(ts: $0, now: now, format: .long) }
                ?? "committed " + formatRelativeTime(ts: commitTs, now: now, format: .long)
            return BuildIdentity(displayVersion: "\(machine) — \(age)\(dirty ? ", with uncommitted changes" : "")",
                                 machineVersion: machine, dirty: dirty, rev: rev, commitTs: commitTs, buildTs: buildTs)
        }
    }
}
