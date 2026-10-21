// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "SchemaCodegenSwiftFixture",
  platforms: [.macOS(.v13), .iOS(.v16)],
  products: [.library(name: "GeneratedContracts", targets: ["GeneratedContracts"])],
  dependencies: [.package(path: "../../../../../../swift/OverengKit")],
  targets: [
    .target(name: "GeneratedContracts", dependencies: [.product(name: "CodableHelpers", package: "OverengKit")], exclude: ["Contracts.swift.genie.ts", "Secondary.swift.genie.ts"]),
    .testTarget(name: "GeneratedContractsTests", dependencies: ["GeneratedContracts", .product(name: "CodableHelpers", package: "OverengKit")]),
  ]
)
