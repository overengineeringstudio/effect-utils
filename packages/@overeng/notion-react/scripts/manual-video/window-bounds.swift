import CoreGraphics
import Foundation

typealias WindowInfo = [String: Any]

struct Bounds {
  let x: Int
  let y: Int
  let width: Int
  let height: Int
}

struct Candidate {
  let id: Int
  let pid: Int
  let owner: String
  let title: String
  let bounds: Bounds
}

func parseBounds(_ info: WindowInfo) -> Bounds {
  let bounds = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let x = (bounds["X"] as? NSNumber)?.intValue ?? 0
  let y = (bounds["Y"] as? NSNumber)?.intValue ?? 0
  let width = (bounds["Width"] as? NSNumber)?.intValue ?? 0
  let height = (bounds["Height"] as? NSNumber)?.intValue ?? 0
  return Bounds(x: x, y: y, width: width, height: height)
}

func area(_ bounds: Bounds) -> Int {
  max(bounds.width, 0) * max(bounds.height, 0)
}

func intersectsVertically(_ a: Bounds, _ b: Bounds) -> Int {
  let top = max(a.y, b.y)
  let bottom = min(a.y + a.height, b.y + b.height)
  return max(bottom - top, 0)
}

func candidates(owner: String) -> [Candidate] {
  let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [WindowInfo] ?? []
  return infos.compactMap { info in
    guard let currentOwner = info[kCGWindowOwnerName as String] as? String, currentOwner == owner else {
      return nil
    }
    let title = (info[kCGWindowName as String] as? String) ?? ""
    let bounds = parseBounds(info)
    let id = (info[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
    let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
    guard bounds.width >= 500, bounds.height >= 500 else {
      return nil
    }
    return Candidate(id: id, pid: pid, owner: owner, title: title, bounds: bounds)
  }
}

func matchByPid(candidates: [Candidate], pid: Int?) -> Candidate? {
  guard let pid else { return nil }
  let matches = candidates.filter { $0.pid == pid }
  return matches.count == 1 ? matches[0] : nil
}

func matchById(candidates: [Candidate], id: Int?) -> Candidate? {
  guard let id else { return nil }
  return candidates.first { $0.id == id }
}

func matchByTitle(candidates: [Candidate], titleFragment: String) -> Candidate? {
  guard titleFragment.isEmpty == false else { return nil }
  return candidates.first {
    $0.title.localizedCaseInsensitiveContains(titleFragment)
  }
}

func fallbackGhostty(candidates: [Candidate]) -> Candidate? {
  candidates
    .filter { $0.title.contains("effect-utils") || $0.title.contains("notion-demo-video") }
    .max(by: { area($0.bounds) < area($1.bounds) })
    ?? candidates.max(by: { area($0.bounds) < area($1.bounds) })
}

func fallbackChrome(candidates: [Candidate], relativeTo ghostty: Candidate?) -> Candidate? {
  let relevant = candidates.filter { candidate in
    candidate.title.isEmpty == false && candidate.bounds.width >= 700
  }
  guard let ghostty else {
    return relevant.max(by: { area($0.bounds) < area($1.bounds) })
  }
  return relevant
    .filter { candidate in
      candidate.bounds.x >= ghostty.bounds.x &&
        intersectsVertically(candidate.bounds, ghostty.bounds) >= 300
    }
    .max(by: { area($0.bounds) < area($1.bounds) })
    ?? relevant.max(by: { area($0.bounds) < area($1.bounds) })
}

func format(_ bounds: Bounds) -> String {
  "\(bounds.x),\(bounds.y),\(bounds.width),\(bounds.height)"
}

func describe(_ candidate: Candidate) -> String {
  "id=\(candidate.id) pid=\(candidate.pid) owner=\(candidate.owner) title=\(candidate.title.isEmpty ? "<untitled>" : candidate.title) bounds=\(format(candidate.bounds))"
}

func dumpCandidates(_ candidates: [Candidate]) {
  for candidate in candidates.sorted(by: { area($0.bounds) > area($1.bounds) }) {
    print(describe(candidate))
  }
}

func resolveWindow(
  role: String,
  candidates: [Candidate],
  windowId: Int?,
  titleFragment: String,
  pid: Int?,
  fallback: () -> Candidate?
) -> Candidate? {
  if let byId = matchById(candidates: candidates, id: windowId) {
    return byId
  }
  if let byTitle = matchByTitle(candidates: candidates, titleFragment: titleFragment) {
    return byTitle
  }
  if let byPid = matchByPid(candidates: candidates, pid: pid) {
    return byPid
  }
  let allowFallback = ProcessInfo.processInfo.environment["NOTION_VIDEO_ALLOW_WINDOW_FALLBACK"] == "1"
  if allowFallback, let candidate = fallback() {
    return candidate
  }

  let message = [
    "failed to resolve \(role) window",
    "title_fragment=\(titleFragment.isEmpty ? "<empty>" : titleFragment)",
    "window_id=\(windowId.map(String.init) ?? "<unset>")",
    "pid=\(pid.map(String.init) ?? "<unset>")",
    "allow_fallback=\(allowFallback ? "1" : "0")",
    "candidates:",
    candidates.isEmpty ? "  <none>" : candidates.map { "  " + describe($0) }.joined(separator: "\n"),
  ].joined(separator: "\n")
  fputs(message + "\n", stderr)
  return nil
}

let ghosttyTitle = ProcessInfo.processInfo.environment["NOTION_VIDEO_GHOSTTY_TITLE_FRAGMENT"] ?? "notion-demo-video"
let chromeTitle = ProcessInfo.processInfo.environment["NOTION_VIDEO_CHROME_TITLE_FRAGMENT"] ?? "@overeng/notion-react manual demo"
let ghosttyWindowId = ProcessInfo.processInfo.environment["NOTION_VIDEO_GHOSTTY_WINDOW_ID"].flatMap(Int.init)
let chromeWindowId = ProcessInfo.processInfo.environment["NOTION_VIDEO_CHROME_WINDOW_ID"].flatMap(Int.init)
let ghosttyPid = ProcessInfo.processInfo.environment["NOTION_VIDEO_GHOSTTY_PID"].flatMap(Int.init)
let chromePid = ProcessInfo.processInfo.environment["NOTION_VIDEO_CHROME_PID"].flatMap(Int.init)

let ghosttyCandidates = candidates(owner: "Ghostty")
let chromeCandidates = candidates(owner: "Google Chrome")

let selector = CommandLine.arguments.dropFirst().first ?? "combined"
switch selector {
case "ghostty-candidates":
  dumpCandidates(ghosttyCandidates)
case "chrome-candidates":
  dumpCandidates(chromeCandidates)
case "all-candidates":
  dumpCandidates(ghosttyCandidates)
  dumpCandidates(chromeCandidates)
case "ghostty":
  guard let ghostty = resolveWindow(
    role: "ghostty",
    candidates: ghosttyCandidates,
    windowId: ghosttyWindowId,
    titleFragment: ghosttyTitle,
    pid: ghosttyPid,
    fallback: { fallbackGhostty(candidates: ghosttyCandidates) }
  ) else { exit(1) }
  print(format(ghostty.bounds))
case "chrome":
  guard let ghostty = resolveWindow(
    role: "ghostty",
    candidates: ghosttyCandidates,
    windowId: ghosttyWindowId,
    titleFragment: ghosttyTitle,
    pid: ghosttyPid,
    fallback: { fallbackGhostty(candidates: ghosttyCandidates) }
  ), let chrome = resolveWindow(
    role: "chrome",
    candidates: chromeCandidates,
    windowId: chromeWindowId,
    titleFragment: chromeTitle,
    pid: chromePid,
    fallback: { fallbackChrome(candidates: chromeCandidates, relativeTo: ghostty) }
  ) else { exit(1) }
  print(format(chrome.bounds))
case "ghostty-id":
  guard let ghostty = resolveWindow(
    role: "ghostty",
    candidates: ghosttyCandidates,
    windowId: ghosttyWindowId,
    titleFragment: ghosttyTitle,
    pid: ghosttyPid,
    fallback: { fallbackGhostty(candidates: ghosttyCandidates) }
  ) else { exit(1) }
  print("\(ghostty.id)")
case "chrome-id":
  guard let ghostty = resolveWindow(
    role: "ghostty",
    candidates: ghosttyCandidates,
    windowId: ghosttyWindowId,
    titleFragment: ghosttyTitle,
    pid: ghosttyPid,
    fallback: { fallbackGhostty(candidates: ghosttyCandidates) }
  ), let chrome = resolveWindow(
    role: "chrome",
    candidates: chromeCandidates,
    windowId: chromeWindowId,
    titleFragment: chromeTitle,
    pid: chromePid,
    fallback: { fallbackChrome(candidates: chromeCandidates, relativeTo: ghostty) }
  ) else { exit(1) }
  print("\(chrome.id)")
case "ghostty-pid":
  guard let ghostty = resolveWindow(
    role: "ghostty",
    candidates: ghosttyCandidates,
    windowId: ghosttyWindowId,
    titleFragment: ghosttyTitle,
    pid: ghosttyPid,
    fallback: { fallbackGhostty(candidates: ghosttyCandidates) }
  ) else { exit(1) }
  print("\(ghostty.pid)")
case "chrome-pid":
  guard let ghostty = resolveWindow(
    role: "ghostty",
    candidates: ghosttyCandidates,
    windowId: ghosttyWindowId,
    titleFragment: ghosttyTitle,
    pid: ghosttyPid,
    fallback: { fallbackGhostty(candidates: ghosttyCandidates) }
  ), let chrome = resolveWindow(
    role: "chrome",
    candidates: chromeCandidates,
    windowId: chromeWindowId,
    titleFragment: chromeTitle,
    pid: chromePid,
    fallback: { fallbackChrome(candidates: chromeCandidates, relativeTo: ghostty) }
  ) else { exit(1) }
  print("\(chrome.pid)")
case "combined":
  guard let ghostty = resolveWindow(
    role: "ghostty",
    candidates: ghosttyCandidates,
    windowId: ghosttyWindowId,
    titleFragment: ghosttyTitle,
    pid: ghosttyPid,
    fallback: { fallbackGhostty(candidates: ghosttyCandidates) }
  ), let chrome = resolveWindow(
    role: "chrome",
    candidates: chromeCandidates,
    windowId: chromeWindowId,
    titleFragment: chromeTitle,
    pid: chromePid,
    fallback: { fallbackChrome(candidates: chromeCandidates, relativeTo: ghostty) }
  ) else { exit(1) }
  let left = min(ghostty.bounds.x, chrome.bounds.x)
  let top = min(ghostty.bounds.y, chrome.bounds.y)
  let right = max(ghostty.bounds.x + ghostty.bounds.width, chrome.bounds.x + chrome.bounds.width)
  let bottom = max(ghostty.bounds.y + ghostty.bounds.height, chrome.bounds.y + chrome.bounds.height)
  let combined = Bounds(x: left, y: top, width: right - left, height: bottom - top)
  print(format(combined))
default:
  fputs("unknown selector: \(selector)\n", stderr)
  exit(1)
}
