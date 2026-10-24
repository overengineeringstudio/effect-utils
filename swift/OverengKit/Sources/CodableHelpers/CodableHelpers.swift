/// A JSON null literal, not an absent key or an unconstrained optional value.
public enum JSONNull: Codable, Equatable, Sendable {
    case null

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard container.decodeNil() else {
            throw DecodingError.typeMismatch(Self.self, .init(codingPath: decoder.codingPath,
                debugDescription: "Expected JSON null"))
        }
        self = .null
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encodeNil()
    }
}

/// Key presence is independent of nullability. A keyed container owns encoding:
/// `.absent` omits the key; `.present(nil)` encodes null when Value is Optional.
public enum Presence<Value: Codable & Equatable & Sendable>: Equatable, Sendable {
    case absent
    case present(Value)
}
