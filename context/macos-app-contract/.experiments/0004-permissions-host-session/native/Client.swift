import Foundation
import Darwin

// Disposable experiment transport: one bounded JSON object per line, one response.
func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(64) }
let args = Array(CommandLine.arguments.dropFirst())
guard args.first == "ask" else { fail("usage: client ask --socket PATH --request JSON [--allow-prompt]") }
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
guard let path = option("--socket"), let text = option("--request"),
      let bytes = text.data(using: .utf8),
      var request = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { fail("invalid request") }
// JSON cannot smuggle a waiver: only the explicit command-line flag can set it.
request["allowPrompt"] = args.contains("--allow-prompt")
let encoded = try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys]) + Data([10])
guard encoded.count <= 65536 else { fail("request too large") }
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
let capacity = MemoryLayout.size(ofValue: address.sun_path)
guard path.utf8.count < capacity else { fail("socket path too long") }
withUnsafeMutableBytes(of: &address.sun_path) { buffer in
    buffer.initializeMemory(as: UInt8.self, repeating: 0)
    buffer.copyBytes(from: path.utf8)
}
let fd = socket(AF_UNIX, SOCK_STREAM, 0)
guard fd >= 0 else { fail("socket failed") }
var noSignal: Int32 = 1
setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
guard connected == 0 else { fail("connect failed: \(errno)") }
let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
try handle.write(contentsOf: encoded)
// The sealed host reads until EOF; half-close writes so a short request can complete.
shutdown(fd, SHUT_WR)
var response = Data()
while response.count <= 1_048_576 {
    guard let chunk = try handle.read(upToCount: 4096), !chunk.isEmpty else { break }
    response.append(chunk)
    if response.contains(10) { break }
}
guard response.last == 10, response.count <= 1_048_576 else { fail("invalid response framing") }
try FileHandle.standardOutput.write(contentsOf: response)
let result = (try? JSONSerialization.jsonObject(with: response)) as? [String: Any]
exit(result?["status"] as? String == "ok" ? 0 : 1)
