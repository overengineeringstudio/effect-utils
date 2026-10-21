import CryptoKit
import Foundation

public enum CanonicalJSONError: Error, Equatable, Sendable {
    case invalidJSON(offset: Int)
}

/// The canonical-json byte protocol: recursively sorted UTF-16 keys and
/// ECMAScript JSON scalar spelling, not discriminator-first schema encoding.
public enum ContentAddress {
    public static func hashBytes(_ bytes: Data) -> String {
        let hex = Array("0123456789abcdef".utf8)
        var result = Array("sha256:".utf8)
        result.reserveCapacity(71)
        for byte in SHA256.hash(data: bytes) {
            result.append(hex[Int(byte >> 4)])
            result.append(hex[Int(byte & 15)])
        }
        return String(decoding: result, as: UTF8.self)
    }

    public static func hashUTF8(_ value: String) -> String { hashBytes(Data(value.utf8)) }

    /// Accepts JSON text so Unicode keys that Swift String considers canonically
    /// equivalent remain distinct, and escaped lone surrogates remain lossless.
    public static func canonicalJSONString(fromJSON data: Data) throws -> String {
        guard let text = String(data: data, encoding: .utf8) else {
            throw CanonicalJSONError.invalidJSON(offset: 0)
        }
        var parser = Parser(units: Array(text.utf16))
        let value = try parser.value()
        parser.whitespace()
        guard parser.index == parser.units.count else { throw parser.error }
        var output = ""
        value.render(into: &output)
        return output
    }

    public static func canonicalJSONBytes(fromJSON data: Data) throws -> Data {
        Data(try canonicalJSONString(fromJSON: data).utf8)
    }

    public static func hashCanonicalJSON(fromJSON data: Data) throws -> String {
        hashBytes(try canonicalJSONBytes(fromJSON: data))
    }

    /// Canonicalizes the encoded wire value; configure dates and other strategies
    /// on the supplied encoder, just as the TypeScript API first encodes a schema.
    public static func canonicalJSONString<T: Encodable>(_ value: T, encoder: JSONEncoder = JSONEncoder()) throws -> String {
        try canonicalJSONString(fromJSON: encoder.encode(value))
    }

    public static func canonicalJSONBytes<T: Encodable>(_ value: T, encoder: JSONEncoder = JSONEncoder()) throws -> Data {
        Data(try canonicalJSONString(value, encoder: encoder).utf8)
    }

    public static func hashCanonicalJSON<T: Encodable>(_ value: T, encoder: JSONEncoder = JSONEncoder()) throws -> String {
        hashBytes(try canonicalJSONBytes(value, encoder: encoder))
    }
}

private indirect enum Value {
    case literal(String)
    case string([UInt16])
    case number(Double)
    case array([Value])
    case object([Member])

    struct Member { let key: [UInt16]; let value: Value }

    func render(into output: inout String) {
        switch self {
        case .literal(let text): output += text
        case .string(let units): quote(units, into: &output)
        case .number(let value): output += numberString(value)
        case .array(let values):
            output += "["
            for (index, value) in values.enumerated() {
                if index != 0 { output += "," }
                value.render(into: &output)
            }
            output += "]"
        case .object(let members):
            output += "{"
            for (index, member) in members.sorted(by: { $0.key.lexicographicallyPrecedes($1.key) }).enumerated() {
                if index != 0 { output += "," }
                quote(member.key, into: &output)
                output += ":"
                member.value.render(into: &output)
            }
            output += "}"
        }
    }
}

private let jsonHexDigits = Array("0123456789abcdef".unicodeScalars)

private func quote(_ units: [UInt16], into output: inout String) {
    output += "\""
    var index = 0
    while index < units.count {
        let unit = units[index]
        switch unit {
        case 34, 92:
            output += "\\"
            output.unicodeScalars.append(UnicodeScalar(unit)!)
        case 8: output += "\\b"
        case 9: output += "\\t"
        case 10: output += "\\n"
        case 12: output += "\\f"
        case 13: output += "\\r"
        case 0xD800...0xDBFF where index + 1 < units.count && (0xDC00...0xDFFF).contains(units[index + 1]):
            let scalar = 0x10000 + (UInt32(unit) - 0xD800) * 0x400 + UInt32(units[index + 1]) - 0xDC00
            output.unicodeScalars.append(UnicodeScalar(scalar)!)
            index += 1
        case 0...31, 0xD800...0xDFFF:
            output += "\\u"
            output.unicodeScalars.append(jsonHexDigits[Int(unit >> 12)])
            output.unicodeScalars.append(jsonHexDigits[Int((unit >> 8) & 15)])
            output.unicodeScalars.append(jsonHexDigits[Int((unit >> 4) & 15)])
            output.unicodeScalars.append(jsonHexDigits[Int(unit & 15)])
        default: output.unicodeScalars.append(UnicodeScalar(unit)!)
        }
        index += 1
    }
    output += "\""
}

/// Swift's shortest round-tripping binary64 significand, laid out with the
/// ECMAScript fixed/exponential thresholds and exponent spelling.
private func numberString(_ value: Double) -> String {
    guard value.isFinite else { return "null" }
    if value == 0 { return "0" }
    let sign = value < 0 ? "-" : ""
    let parts = String(abs(value)).lowercased().split(separator: "e")
    let mantissa = String(parts[0])
    let exponent = parts.count == 2 ? Int(parts[1])! : 0
    let point = mantissa.firstIndex(of: ".") ?? mantissa.endIndex
    var decimalPosition = mantissa.distance(from: mantissa.startIndex, to: point) + exponent
    var digits = mantissa.filter { $0 != "." }
    while digits.first == "0" { digits.removeFirst(); decimalPosition -= 1 }
    while digits.last == "0" { digits.removeLast() }
    let count = digits.count
    if decimalPosition > 0 && decimalPosition <= 21 {
        if decimalPosition >= count { return sign + digits + String(repeating: "0", count: decimalPosition - count) }
        let split = digits.index(digits.startIndex, offsetBy: decimalPosition)
        return sign + digits[..<split] + "." + digits[split...]
    }
    if decimalPosition <= 0 && decimalPosition > -6 {
        return sign + "0." + String(repeating: "0", count: -decimalPosition) + digits
    }
    let rest = digits.dropFirst()
    let coefficient = String(digits.first!) + (rest.isEmpty ? "" : "." + rest)
    let power = decimalPosition - 1
    return sign + coefficient + "e" + (power >= 0 ? "+" : "") + String(power)
}

private struct Parser {
    let units: [UInt16]
    var index = 0
    var error: CanonicalJSONError { .invalidJSON(offset: index) }
    mutating func whitespace() {
        while index < units.count && [9, 10, 13, 32].contains(units[index]) { index += 1 }
    }
    mutating func take(_ unit: UInt16) -> Bool {
        if index < units.count && units[index] == unit { index += 1; return true }
        return false
    }
    mutating func require(_ unit: UInt16) throws { guard take(unit) else { throw error } }

    mutating func value() throws -> Value {
        whitespace()
        guard index < units.count else { throw error }
        switch units[index] {
        case 34: return .string(try string())
        case 91:
            index += 1; whitespace()
            var values: [Value] = []
            if take(93) { return .array(values) }
            repeat { values.append(try value()); whitespace() } while take(44)
            try require(93)
            return .array(values)
        case 123:
            index += 1; whitespace()
            var members: [Value.Member] = []
            if take(125) { return .object(members) }
            repeat {
                whitespace()
                let key = try string()
                whitespace(); try require(58)
                let member = Value.Member(key: key, value: try value())
                // JSON.parse's last exact UTF-16 key wins, without normalization.
                if let existing = members.firstIndex(where: { $0.key == key }) { members[existing] = member }
                else { members.append(member) }
                whitespace()
            } while take(44)
            try require(125)
            return .object(members)
        case 110, 116, 102:
            let text = units[index] == 110 ? "null" : units[index] == 116 ? "true" : "false"
            for unit in text.utf16 { try require(unit) }
            return .literal(text)
        default: return try number()
        }
    }

    mutating func string() throws -> [UInt16] {
        try require(34)
        var result: [UInt16] = []
        while index < units.count {
            let unit = units[index]; index += 1
            if unit == 34 { return result }
            guard unit >= 32 else { throw error }
            if unit != 92 { result.append(unit); continue }
            guard index < units.count else { throw error }
            let escaped = units[index]; index += 1
            switch escaped {
            case 34, 47, 92: result.append(escaped)
            case 98: result.append(8)
            case 102: result.append(12)
            case 110: result.append(10)
            case 114: result.append(13)
            case 116: result.append(9)
            case 117:
                var decoded: UInt16 = 0
                for _ in 0..<4 {
                    guard index < units.count else { throw error }
                    let digit = units[index]; index += 1
                    let nibble: UInt16
                    switch digit {
                    case 48...57: nibble = digit - 48
                    case 65...70: nibble = digit - 55
                    case 97...102: nibble = digit - 87
                    default: throw error
                    }
                    decoded = decoded * 16 + nibble
                }
                result.append(decoded)
            default: throw error
            }
        }
        throw error
    }

    mutating func number() throws -> Value {
        let start = index
        _ = take(45)
        guard index < units.count else { throw error }
        if !take(48) {
            guard (49...57).contains(units[index]) else { throw error }
            index += 1
            while index < units.count && (48...57).contains(units[index]) { index += 1 }
        }
        if take(46) { try digits() }
        if take(101) || take(69) {
            if !take(43) { _ = take(45) }
            try digits()
        }
        guard let number = Double(String(decoding: units[start..<index], as: UTF16.self)) else { throw error }
        return .number(number)
    }

    mutating func digits() throws {
        let start = index
        while index < units.count && (48...57).contains(units[index]) { index += 1 }
        guard index > start else { throw error }
    }
}
