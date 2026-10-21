import Foundation
import XCTest
@testable import BuildIdentity

final class BuildIdentityTests: XCTestCase {
    func testPortableSpecGoldens() throws {
        struct Fixture: Decodable {
            struct Identity: Decodable {
                let stamp: BuildStamp
                let machineVersion: String
                let displayVersion: String
                let short: String
            }
            struct Relative: Decodable { let elapsed: Double; let value: String }
            let now: Double
            let identities: [Identity]
            let relativeTimes: [Relative]
        }
        let url = try XCTUnwrap(Bundle.module.url(forResource: "identity", withExtension: "json", subdirectory: "Goldens"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        for identity in fixture.identities {
            XCTAssertEqual(identity.stamp.machineVersion, identity.machineVersion)
            XCTAssertEqual(identity.stamp.displayVersion(now: fixture.now), identity.displayVersion)
            XCTAssertEqual(identity.stamp.short(now: fixture.now), identity.short)
        }
        for relative in fixture.relativeTimes {
            XCTAssertEqual(formatRelativeTime(ts: 0, now: relative.elapsed), relative.value)
        }
    }

    func testMachineAndDisplayExamples() {
        let now = 1_800_000_000.0
        let clean = BuildStamp(baseVersion: "0.1.0", rev: "7d5211e123456789", dirty: false,
                               sourceKind: .nix, commitTs: now - 4 * 86_400)
        XCTAssertEqual(clean.machineVersion, "0.1.0+7d5211e")
        XCTAssertEqual(clean.displayVersion(now: now), "0.1.0+7d5211e — committed 4 days ago")
        let dirty = BuildStamp(baseVersion: "0.1.0", rev: clean.rev, dirty: true,
                               sourceKind: .nix, commitTs: clean.commitTs)
        XCTAssertEqual(dirty.machineVersion, "0.1.0+7d5211e-dirty")
        XCTAssertEqual(dirty.displayVersion(now: now), "0.1.0+7d5211e-dirty — committed 4 days ago, with uncommitted changes")
        XCTAssertEqual(BuildStamp(baseVersion: "0.1.0", dirty: false, sourceKind: .nix).machineVersion, "0.1.0")
        let local = BuildStamp(baseVersion: "0.1.0", rev: "7d5211e", dirty: false,
                               sourceKind: .local, buildTs: now - 300)
        XCTAssertEqual(local.displayVersion(now: now), "0.1.0 — running from local source (7d5211e, 5 min ago)")
        let committedLocal = BuildStamp(baseVersion: "0.1.0", rev: clean.rev, dirty: false,
                                        sourceKind: .local, commitTs: clean.commitTs, buildTs: now)
        XCTAssertEqual(committedLocal.displayVersion(now: now), clean.displayVersion(now: now))
    }

    func testShortAndDetailsExamples() {
        let now = 1_800_000_000.0
        let clean = BuildStamp(baseVersion: "0.1.0", rev: "a7647bb123", dirty: false,
                               sourceKind: .local, commitTs: now - 10_800, buildTs: now - 720)
        XCTAssertEqual(clean.short(now: now), "a7647bb · 3h")
        XCTAssertEqual(clean.details(now: now), [
            BuildIdentityDetail(label: "displayVersion", value: clean.displayVersion(now: now)),
            BuildIdentityDetail(label: "machineVersion", value: "0.1.0+a7647bb"),
            BuildIdentityDetail(label: "deployed", value: "12m ago"),
        ])
        let dirty = BuildStamp(baseVersion: "0.1.0", rev: clean.rev, dirty: true,
                               sourceKind: .local, commitTs: now - 172_800)
        XCTAssertEqual(dirty.short(now: now), "a7647bb* · 2d")
        XCTAssertEqual(dirty.details(now: now).count, 2)
        for rev in [nil, ""] as [String?] {
            let missing = BuildStamp(baseVersion: "0.1.0", rev: rev, dirty: true,
                                     sourceKind: .local, buildTs: now)
            XCTAssertEqual(missing.short(now: now), "n/a* · n/a")
        }
        XCTAssertEqual(BuildStamp(baseVersion: "0.1.0", rev: clean.rev, dirty: true,
                                  sourceKind: .local, buildTs: now).short(now: now), "a7647bb* · n/a")
    }

    func testCompactBucketBoundariesAndInvalidTimes() {
        let vectors: [(Double, String)] = [
            (0, "0s"), (59.9, "59s"), (60, "1m"), (3_599, "59m"),
            (3_600, "1h"), (86_399, "23h"), (86_400, "1d"),
            (2_591_999, "29d"), (2_592_000, "1mo"), (31_535_999, "12mo"),
            (31_536_000, "1y"), (63_072_000, "2y"),
        ]
        for (elapsed, expected) in vectors {
            XCTAssertEqual(formatRelativeTime(ts: 0, now: elapsed), expected)
        }
        XCTAssertEqual(formatRelativeTime(ts: 100, now: 0), "0s")
        for invalid in [Double.nan, .infinity, -.infinity] {
            XCTAssertEqual(formatRelativeTime(ts: invalid, now: 0), "n/a")
            XCTAssertEqual(formatRelativeTime(ts: 0, now: invalid), "n/a")
        }
        let invalid = BuildStamp(baseVersion: "0.1", rev: "a7647bb", dirty: false,
                                 sourceKind: .local, commitTs: .nan, buildTs: .infinity)
        XCTAssertEqual(invalid.short(now: 0), "a7647bb · n/a")
        XCTAssertEqual(invalid.details(now: 0).last?.value, "n/a")
    }

    func testStampDecodingHasExplicitUnstampedState() throws {
        XCTAssertEqual(BuildIdentityState.decode(propertyList: nil), .unstamped(reason: "Build stamp missing"))
        XCTAssertEqual(BuildIdentityState.decode(propertyList: ["machineVersion": "0.1+fake"]), .unstamped(reason: "Build stamp invalid"))
        XCTAssertEqual(BuildIdentityState.decode(propertyList: ["baseVersion": "", "dirty": false, "sourceKind": "local"]), .unstamped(reason: "Build stamp invalid"))
        let stamp = BuildStamp(baseVersion: "0.1", rev: "a7647bb", dirty: false,
                               sourceKind: .local, commitTs: 123, buildTs: 456)
        let plist = try PropertyListSerialization.propertyList(from: PropertyListEncoder().encode(stamp), format: nil)
        XCTAssertEqual(BuildIdentityState.decode(propertyList: plist), .stamped(stamp))
        XCTAssertEqual(BundleBuildIdentityProvider(buildIdentity: .unstamped(reason: "legacy")).buildIdentity.machineVersion, "unstamped")
    }
}
