// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OverengKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "ContentAddress", targets: ["ContentAddress"]),
        .library(name: "BuildIdentity", targets: ["BuildIdentity"]),
        .library(name: "CodableHelpers", targets: ["CodableHelpers"]),
    ],
    targets: [
        .target(name: "ContentAddress"),
        .target(name: "BuildIdentity"),
        .target(name: "CodableHelpers"),
        .testTarget(name: "OverengKitTests", dependencies: ["ContentAddress", "BuildIdentity", "CodableHelpers"],
                    resources: [.copy("Goldens")]),
    ]
)
