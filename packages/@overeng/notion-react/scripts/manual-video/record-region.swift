import AVFoundation
import CoreGraphics
import Dispatch
import Foundation
import ScreenCaptureKit

struct RegionRect {
  let x: CGFloat
  let y: CGFloat
  let width: CGFloat
  let height: CGFloat
}

enum RegionRecorderError: Error, CustomStringConvertible {
  case invalidArguments(String)
  case noDisplayForRect(String)
  case failedToAddRecordingOutput(String)
  case recordingFailed(String)

  var description: String {
    switch self {
    case let .invalidArguments(message),
      let .noDisplayForRect(message),
      let .failedToAddRecordingOutput(message),
      let .recordingFailed(message):
      return message
    }
  }
}

final class RecordingDelegate: NSObject, SCRecordingOutputDelegate {
  private let startSemaphore = DispatchSemaphore(value: 0)
  private let finishSemaphore = DispatchSemaphore(value: 0)
  private(set) var startError: Error?
  private(set) var finishError: Error?

  func waitUntilStarted(timeoutSeconds: TimeInterval) throws {
    let result = startSemaphore.wait(timeout: .now() + timeoutSeconds)
    guard result == .success else {
      throw RegionRecorderError.recordingFailed(
        "timed out waiting for recording to start"
      )
    }
    if let startError { throw startError }
  }

  func waitUntilFinished(timeoutSeconds: TimeInterval) throws {
    let result = finishSemaphore.wait(timeout: .now() + timeoutSeconds)
    guard result == .success else {
      throw RegionRecorderError.recordingFailed(
        "timed out waiting for recording to finish"
      )
    }
    if let finishError { throw finishError }
  }

  func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
    startSemaphore.signal()
  }

  func recordingOutput(
    _ recordingOutput: SCRecordingOutput,
    didFailWithError error: any Error
  ) {
    if startError == nil {
      startError = error
      startSemaphore.signal()
    }
    finishError = error
    finishSemaphore.signal()
  }

  func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
    if startError == nil {
      startSemaphore.signal()
    }
    finishSemaphore.signal()
  }
}

final class RetainedColor {
  let value: CGColor

  init(gray: CGFloat, alpha: CGFloat) {
    self.value = CGColor(gray: gray, alpha: alpha)
  }
}

func parseArguments() throws -> (outputFile: String, rect: RegionRect, fps: Int) {
  let arguments = Array(CommandLine.arguments.dropFirst())
  guard arguments.count >= 3 else {
    throw RegionRecorderError.invalidArguments(
      "usage: swift record-region.swift <output.mp4> <x,y,width,height> <fps>"
    )
  }

  let outputFile = arguments[0]
  let rectParts = arguments[1].split(separator: ",").map(String.init)
  guard rectParts.count == 4,
    let x = Double(rectParts[0]),
    let y = Double(rectParts[1]),
    let width = Double(rectParts[2]),
    let height = Double(rectParts[3]),
    let fps = Int(arguments[2]),
    fps > 0
  else {
    throw RegionRecorderError.invalidArguments(
      "expected rect as x,y,width,height and fps > 0"
    )
  }

  return (
    outputFile,
    RegionRect(
      x: CGFloat(x),
      y: CGFloat(y),
      width: CGFloat(width),
      height: CGFloat(height)
    ),
    fps
  )
}

func intersectionArea(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
  let intersection = lhs.intersection(rhs)
  if intersection.isNull || intersection.isEmpty {
    return 0
  }
  return intersection.width * intersection.height
}

func matchingDisplay(
  for rect: RegionRect,
  in content: SCShareableContent
) -> SCDisplay? {
  let target = CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
  return content.displays.max(by: { lhs, rhs in
    intersectionArea(lhs.frame, target) < intersectionArea(rhs.frame, target)
  })
}

func waitForStopSignal() async {
  signal(SIGINT, SIG_IGN)
  signal(SIGTERM, SIG_IGN)

  await withCheckedContinuation { continuation in
    let queue = DispatchQueue(label: "notion.manual-demo.region-recorder.signals")
    let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: queue)
    let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: queue)
    let lock = NSLock()
    var resumed = false

    let resumeOnce = {
      lock.lock()
      defer { lock.unlock() }
      guard resumed == false else { return }
      resumed = true
      continuation.resume()
      sigintSource.cancel()
      sigtermSource.cancel()
    }

    sigintSource.setEventHandler(handler: resumeOnce)
    sigtermSource.setEventHandler(handler: resumeOnce)
    sigintSource.resume()
    sigtermSource.resume()
  }
}

func runRecorder() async throws {
    let (outputFile, rect, fps) = try parseArguments()
    let outputURL = URL(fileURLWithPath: outputFile)
    try FileManager.default.createDirectory(
      at: outputURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try? FileManager.default.removeItem(at: outputURL)

    let content = try await SCShareableContent.current
    guard let display = matchingDisplay(for: rect, in: content) else {
      throw RegionRecorderError.noDisplayForRect(
        "no display found for capture rect \(rect.x),\(rect.y),\(rect.width),\(rect.height)"
      )
    }

    let localRect = CGRect(
      x: rect.x - display.frame.origin.x,
      y: rect.y - display.frame.origin.y,
      width: rect.width,
      height: rect.height
    )

    let filter = SCContentFilter(
      display: display,
      excludingApplications: [],
      exceptingWindows: []
    )
    let configuration = SCStreamConfiguration()
    configuration.sourceRect = localRect
    configuration.width = Int(rect.width.rounded(.toNearestOrAwayFromZero))
    configuration.height = Int(rect.height.rounded(.toNearestOrAwayFromZero))
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    configuration.showsCursor = false
    configuration.captureResolution = .automatic
    configuration.queueDepth = 5
    let backgroundColor = RetainedColor(gray: 0, alpha: 1)
    configuration.backgroundColor = backgroundColor.value
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.capturesAudio = false

    let delegate = RecordingDelegate()
    let recordingConfiguration = SCRecordingOutputConfiguration()
    recordingConfiguration.outputURL = outputURL
    recordingConfiguration.videoCodecType = .h264
    recordingConfiguration.outputFileType = .mp4
    let recordingOutput = SCRecordingOutput(
      configuration: recordingConfiguration,
      delegate: delegate
    )

    let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
    do {
      try stream.addRecordingOutput(recordingOutput)
    } catch {
      throw RegionRecorderError.failedToAddRecordingOutput(
        "failed to add recording output: \(error)"
      )
    }

    try await stream.startCapture()
    try delegate.waitUntilStarted(timeoutSeconds: 10)

    let startMessage = [
      "recording_started=true",
      "output=\(outputFile)",
      "displayId=\(display.displayID)",
      "displayFrame=\(Int(display.frame.origin.x)),\(Int(display.frame.origin.y)),\(Int(display.frame.width)),\(Int(display.frame.height))",
      "sourceRect=\(Int(localRect.origin.x)),\(Int(localRect.origin.y)),\(Int(localRect.width)),\(Int(localRect.height))",
      "fps=\(fps)",
    ].joined(separator: " ")
    print(startMessage)
    fflush(stdout)

    await waitForStopSignal()

    try await stream.stopCapture()
    try delegate.waitUntilFinished(timeoutSeconds: 10)
    withExtendedLifetime(backgroundColor) {}

    let fileSize =
      (try? FileManager.default.attributesOfItem(atPath: outputFile)[.size] as? NSNumber)?
      .intValue ?? 0
    print("recording_finished=true output=\(outputFile) size_bytes=\(fileSize)")
}

let finished = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
  do {
    try await runRecorder()
  } catch {
    fputs("\(error)\n", stderr)
    exitCode = 1
  }
  finished.signal()
}

finished.wait()
exit(exitCode)
