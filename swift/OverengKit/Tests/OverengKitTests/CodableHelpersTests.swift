import Foundation
import XCTest
import CodableHelpers

final class CodableHelpersTests: XCTestCase {
    func testJSONNullRequiresAndEncodesNull() throws {
        XCTAssertEqual(try JSONDecoder().decode(JSONNull.self, from: Data("null".utf8)), .null)
        XCTAssertEqual(try JSONEncoder().encode(JSONNull.null), Data("null".utf8))
        for text in ["0", "false", "\"null\"", "{}", "[]"] {
            XCTAssertThrowsError(try JSONDecoder().decode(JSONNull.self, from: Data(text.utf8)))
        }
    }

    func testAbsentNullAndPresentAreDistinct() {
        let absent: Presence<String?> = .absent
        let null: Presence<String?> = .present(nil)
        let present: Presence<String?> = .present("value")
        XCTAssertNotEqual(absent, null)
        XCTAssertNotEqual(null, present)
        XCTAssertEqual(null, .present(nil))
    }
}
