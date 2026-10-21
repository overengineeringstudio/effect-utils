import Foundation

public enum BuildIdentityState: Equatable, Sendable {
    case stamped(BuildStamp)
    case unstamped(reason: String)

    public var stamp: BuildStamp? {
        if case .stamped(let stamp) = self { return stamp }
        return nil
    }
    public var machineVersion: String { stamp?.machineVersion ?? "unstamped" }
    public func displayVersion(now: Double) -> String {
        switch self {
        case .unstamped(let reason): return "Unstamped — \(reason)"
        case .stamped(let stamp): return stamp.displayVersion(now: now)
        }
    }
    public func short(now: Double) -> String { stamp?.short(now: now) ?? "unstamped" }
    public func details(now: Double) -> [BuildIdentityDetail] {
        stamp?.details(now: now) ?? [
            BuildIdentityDetail(label: "displayVersion", value: displayVersion(now: now)),
            BuildIdentityDetail(label: "machineVersion", value: machineVersion),
        ]
    }

    /// Missing/malformed metadata is explicit, never synthesized from bundle ordinals.
    public static func decode(propertyList value: Any?) -> BuildIdentityState {
        guard let value else { return .unstamped(reason: "Build stamp missing") }
        do {
            let data = try PropertyListSerialization.data(fromPropertyList: value, format: .binary, options: 0)
            let stamp = try PropertyListDecoder().decode(BuildStamp.self, from: data)
            guard !stamp.baseVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  stamp.commitTs.map({ $0.isFinite }) ?? true,
                  stamp.buildTs.map({ $0.isFinite }) ?? true else {
                return .unstamped(reason: "Build stamp invalid")
            }
            return .stamped(stamp)
        } catch { return .unstamped(reason: "Build stamp invalid") }
    }
}

public protocol BuildIdentityProviding: Sendable {
    var buildIdentity: BuildIdentityState { get }
}

/// Resolve once at the application composition root, then inject the provider.
public struct BundleBuildIdentityProvider: BuildIdentityProviding {
    public let buildIdentity: BuildIdentityState
    public init(bundle: Bundle = .main, key: String = "BuildIdentity") {
        buildIdentity = .decode(propertyList: bundle.object(forInfoDictionaryKey: key))
    }
    public init(buildIdentity: BuildIdentityState) { self.buildIdentity = buildIdentity }
}
