import Foundation
import XCTest
import BuildIdentity

final class IdentityContractTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Canonical: Decodable {
            let stamp: BuildStamp
            let details: [BuildIdentityDetail]
        }
        struct Relative: Decodable { let elapsed: Double; let value: String }
        struct Supplied: Decodable {
            let identity: BuildIdentity
            let short: String
            let details: [BuildIdentityDetail]
        }
        struct CLI: Decodable {
            let name: String
            let baseVersion: String
            let buildStamp: String
            let environment: [String: String]
            let machineVersion: String
            let displayVersion: String
        }
        let now: Double
        let identities: [Canonical]
        let longRelativeTimes: [Relative]
        let suppliedIdentity: Supplied
        let cliCases: [CLI]
    }

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "identity", withExtension: "json", subdirectory: "Goldens"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testContractOwnedDetailsAndSuppliedValues() throws {
        let fixture = try fixture()
        for item in fixture.identities {
            XCTAssertEqual(item.stamp.details(now: fixture.now), item.details)
        }
        let supplied = fixture.suppliedIdentity
        XCTAssertEqual(supplied.identity.short(now: fixture.now), supplied.short)
        XCTAssertEqual(supplied.identity.details(now: fixture.now), supplied.details)
    }

    func testLongRelativeTimeGoldensAndCalendarDate() throws {
        for item in try fixture().longRelativeTimes {
            XCTAssertEqual(formatRelativeTime(ts: 0, now: item.elapsed, format: .long), item.value)
        }
        let ts = 1_767_355_200.0
        let date = Date(timeIntervalSince1970: ts)
        let month = DateFormatter()
        month.locale = Locale(identifier: "en_US_POSIX")
        month.dateFormat = "MMM"
        let day = Calendar.current.component(.day, from: date)
        XCTAssertEqual(formatRelativeTime(ts: ts, now: ts + 30 * 86_400, format: .long),
                       "\(month.string(from: date)) \(day)")
    }

    func testCLIStampTransportAndPrecedence() throws {
        let fixture = try fixture()
        for item in fixture.cliCases {
            let identity = BuildIdentity.resolveCLI(baseVersion: item.baseVersion, buildStamp: item.buildStamp,
                                                   environment: item.environment, now: fixture.now)
            XCTAssertEqual(identity.machineVersion, item.machineVersion, item.name)
            XCTAssertEqual(identity.displayVersion, item.displayVersion, item.name)
        }
        XCTAssertNil(CLIStamp.parse("{\"type\":\"unknown\"}"))
        XCTAssertNil(CLIStamp.parse("[]"))
        let legacy = CLIStamp.parse("{\"type\":\"local\",\"rev\":\"abc1234\",\"ts\":12,\"dirty\":false}")
        XCTAssertEqual(legacy, .local(rev: "abc1234", ts: 12, dirty: false, commitTs: nil))
    }

    func testBundleProviderUsesPublicGenericKey() throws {
        let stamp = BuildStamp(baseVersion: "1.0", dirty: false, sourceKind: .nix)
        let provider = BundleBuildIdentityProvider(buildIdentity: .stamped(stamp))
        XCTAssertEqual(provider.buildIdentity.stamp, stamp)
        XCTAssertEqual(BuildIdentityState.decode(propertyList: ["baseVersion": "  ", "dirty": false, "sourceKind": "nix"]),
                       .unstamped(reason: "Build stamp invalid"))
        for invalid in [Double.nan, .infinity, -.infinity] {
            XCTAssertEqual(BuildIdentityState.decode(propertyList: ["baseVersion": "1.0", "dirty": false,
                "sourceKind": "nix", "commitTs": invalid]), .unstamped(reason: "Build stamp invalid"))
        }
    }
}
