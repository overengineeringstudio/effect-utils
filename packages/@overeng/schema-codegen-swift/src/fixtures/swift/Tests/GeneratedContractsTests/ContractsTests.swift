import Foundation
import XCTest
import CodableHelpers
import GeneratedContracts

final class ContractsTests: XCTestCase {
  func testProducerRoundtrip() throws {
    let inputs = [
      #"{"_tag":"local","name":"compiler","items":[{"title":"example"}]}"#,
      #"{"_tag":"remote","endpoint":"https://example.test","enabled":true}"#,
      #"{"_tag":"idle"}"#,
    ]
    for input in inputs {
      let value = try JSONDecoder().decode(Producer.self, from: Data(input.utf8))
      XCTAssertEqual(try JSONDecoder().decode(Producer.self, from: JSONEncoder().encode(value)), value)
    }
    let local = try JSONDecoder().decode(Producer.self, from: Data(inputs[0].utf8))
    guard case .local(let payload) = local else { return XCTFail("Expected associated local payload") }
    XCTAssertEqual(payload.name, "compiler")
    XCTAssertEqual(payload.items, [Catalog_Item(title: "example")])
    for input in [#"{"_tag":"unknown"}"#, #"{"_tag":"idle","unexpected":true}"#, #"{"_tag":"remote","endpoint":"x","enabled":null}"#] {
      XCTAssertThrowsError(try JSONDecoder().decode(Producer.self, from: Data(input.utf8)))
    }
  }

  func testAbsentNullAndPresentAreDifferent() throws {
    let decoder = JSONDecoder()
    let absent = try decoder.decode(PresenceSample.self, from: Data(#"{"required":null}"#.utf8))
    let null = try decoder.decode(PresenceSample.self, from: Data(#"{"required":null,"patch":null}"#.utf8))
    let present = try decoder.decode(PresenceSample.self, from: Data(#"{"required":"r","optional":"o","patch":"p"}"#.utf8))
    XCTAssertNil(absent.required)
    XCTAssertNil(absent.optional)
    XCTAssertEqual(absent.patch, .absent)
    XCTAssertEqual(null.patch, .present(nil))
    XCTAssertEqual(present.patch, .present("p"))
    XCTAssertNotEqual(absent, null)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    XCTAssertEqual(String(decoding: try encoder.encode(absent), as: UTF8.self), #"{"required":null}"#)
    XCTAssertEqual(String(decoding: try encoder.encode(null), as: UTF8.self), #"{"patch":null,"required":null}"#)
    for input in [#"{}"#, #"{"required":null,"optional":null}"#] {
      XCTAssertThrowsError(try decoder.decode(PresenceSample.self, from: Data(input.utf8)))
    }
  }
  func testNumericScalarAliases() throws {
    let decoder = JSONDecoder()
    XCTAssertEqual(try decoder.decode(NumberValue.self, from: Data("1.25".utf8)).value, 1.25)
    XCTAssertThrowsError(try NumberValue(.infinity))
    XCTAssertThrowsError(try NumberValue(.nan))
    XCTAssertEqual(try decoder.decode(IntegerValue.self, from: Data("9007199254740991".utf8)).value, 9007199254740991)
    XCTAssertThrowsError(try decoder.decode(IntegerValue.self, from: Data("9007199254740992".utf8)))
    XCTAssertThrowsError(try decoder.decode(IntegerValue.self, from: Data("1.25".utf8)))
  }


  func testScalarValidationAndEmptyObject() throws {
    let decoder = JSONDecoder()
    let value = try decoder.decode(Scalars.self, from: Data(#"{"count":100,"truth":true,"nothing":null,"labels":["a","b"]}"#.utf8))
    XCTAssertEqual(value.count.value, 100)
    XCTAssertEqual(value.nothing, .null)
    XCTAssertEqual(try decoder.decode(Scalars.self, from: JSONEncoder().encode(value)), value)
    for count in ["-1", "101", "1.5", "256"] {
      let input = "{\"count\":\(count),\"truth\":true,\"nothing\":null,\"labels\":[]}"
      XCTAssertThrowsError(try decoder.decode(Scalars.self, from: Data(input.utf8)))
    }
    XCTAssertEqual(try decoder.decode(Mode.self, from: Data(#""active""#.utf8)), .active)
    XCTAssertThrowsError(try decoder.decode(Mode.self, from: Data(#""invalid""#.utf8)))
    XCTAssertEqual(try decoder.decode(Empty.self, from: Data("{}".utf8)), Empty())
    XCTAssertThrowsError(try decoder.decode(Empty.self, from: Data(#"{"x":1}"#.utf8)))
  }
}
