import Foundation
import XCTest
import ContentAddress

final class ContentAddressTests: XCTestCase {
    func testContractOwnedPortableGoldens() throws {
        struct Fixture: Decodable {
            struct Case: Decodable {
                let name: String
                let inputJSON: String
                let canonicalJSON: String
                let sha256: String
            }
            let version: Int
            let cases: [Case]
        }
        let url = try XCTUnwrap(Bundle.module.url(forResource: "content-address", withExtension: "json", subdirectory: "Goldens"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.version, 1)
        for item in fixture.cases {
            let input = Data(item.inputJSON.utf8)
            XCTAssertEqual(try ContentAddress.canonicalJSONString(fromJSON: input), item.canonicalJSON, item.name)
            XCTAssertEqual(try ContentAddress.canonicalJSONBytes(fromJSON: input), Data(item.canonicalJSON.utf8), item.name)
            XCTAssertEqual(try ContentAddress.hashCanonicalJSON(fromJSON: input), item.sha256, item.name)
        }
    }

    func testRawSHA256Vectors() {
        XCTAssertEqual(ContentAddress.hashBytes(Data()), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(ContentAddress.hashUTF8("abc"), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testCanonicalizesEncodedWireValue() throws {
        struct Payload: Encodable {
            let z: Int
            let a: String
            let absent: Int?
        }
        let value = Payload(z: 1, a: "café / 🎙️", absent: nil)
        let expected = "{\"a\":\"café / 🎙️\",\"z\":1}"
        XCTAssertEqual(try ContentAddress.canonicalJSONString(value), expected)
        XCTAssertEqual(try ContentAddress.canonicalJSONBytes(value), Data(expected.utf8))
        XCTAssertEqual(try ContentAddress.hashCanonicalJSON(value), ContentAddress.hashUTF8(expected))
    }

    func testMalformedJSONFailsAtBoundary() {
        for input in ["", "[1,]", "{\"x\":}", "01", "1.", "1e", "-", "true false", "\"\\u00xz\"", "\"unterminated", "[", "{", "[+1]"] {
            XCTAssertThrowsError(try ContentAddress.canonicalJSONString(fromJSON: Data(input.utf8)), input)
        }
        XCTAssertThrowsError(try ContentAddress.canonicalJSONString(fromJSON: Data([0xff])))
    }
}
