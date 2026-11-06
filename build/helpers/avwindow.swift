// Whether anyone can see a window, for the app's away mode.
//
// The renderer's only signal used to be document.visibilityState, and on macOS
// that turns 'hidden' only when the window is minimised or hidden. Electron
// disables Chromium's own occlusion detection (--disable-features=
// MacWebContentsOcclusion), and an enable switch cannot override it: tested on
// Electron 33, the child processes still carry the disable. So a window
// covered by other apps, left on another Space or behind a full-screen app
// looked visible to the page and kept every visual loop running at the
// display's 120 Hz. The window server knows better, so this asks it.
//
// Commands (exit 1 carries {"error":...}):
//   avwindow watch <window-number> <owner-pid>   one line now and one per
//                                                change, polled every second,
//                                                until stdin closes. Read-only.
//
// Only window numbers, bounds, layers, alpha and owners are read, none of which
// needs Screen Recording permission. Anything it cannot work out is reported as
// visible: a wrong "visible" costs some CPU, a wrong "hidden" freezes the
// visuals in front of someone who is watching them.

import CoreGraphics
import Foundation

private let pollIntervalMs = 1000

/// Points sampled across the visible part of the window. Covered means every
/// one of them is under some other app's window: an approximation, but one
/// that a sliver of visible window between two covers can only push towards
/// "visible", and a grid this fine leaves no sliver anyone could watch.
private let gridColumns = 24
private let gridRows = 16

// ── Output ───────────────────────────────────────────────────────────

private func emit(_ payload: [String: Any], exitCode: Int32 = 0) -> Never {
    emitLine(payload)
    exit(exitCode)
}

private func emitLine(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

private func fail(_ message: String) -> Never { emit(["error": message], exitCode: 1) }

// ── Window server ────────────────────────────────────────────────────

private func displayRects() -> [CGRect] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return [] }
    return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
}

private func bounds(_ info: [String: Any]) -> CGRect? {
    guard let dict = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: dict as CFDictionary)
}

/// Why nobody can see the window, or nil if someone can.
private func hiddenReason(window: CGWindowID, ownerPid: Int32) -> String? {
    // Front to back. Leaves out minimised windows, hidden ones, and those on
    // another Space, which is exactly what "not on screen" should mean.
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                kCGNullWindowID) as? [[String: Any]] else { return nil }
    guard let index = list.firstIndex(where: {
        ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window
    }), let mine = bounds(list[index]) else { return "not-on-screen" }

    let shown = displayRects()
        .map { $0.intersection(mine) }
        .filter { !$0.isNull && $0.width >= 1 && $0.height >= 1 }
    if shown.isEmpty { return "not-on-screen" }

    // Only other apps' windows count. The app's own notch HUD and tray menus
    // sit in front of it all day without hiding anything anyone is watching.
    let covers = list[..<index].compactMap { info -> CGRect? in
        guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value != ownerPid,
              ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0.05 else { return nil }
        return bounds(info)
    }
    if covers.isEmpty { return nil }

    for rect in shown {
        for column in 0..<gridColumns {
            for row in 0..<gridRows {
                let point = CGPoint(x: rect.minX + (CGFloat(column) + 0.5) * rect.width / CGFloat(gridColumns),
                                    y: rect.minY + (CGFloat(row) + 0.5) * rect.height / CGFloat(gridRows))
                if !covers.contains(where: { $0.contains(point) }) { return nil }
            }
        }
    }
    return "covered"
}

// ── Entry point ──────────────────────────────────────────────────────

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: avwindow watch <window-number> <owner-pid>") }

switch command {
case "watch":
    guard args.count >= 3, let number = UInt32(args[1]), let pid = Int32(args[2]) else {
        fail("usage: avwindow watch <window-number> <owner-pid>")
    }
    var last: String?? = .none
    let poll = {
        let reason = hiddenReason(window: CGWindowID(number), ownerPid: pid)
        if last == .none || last! != reason {
            last = .some(reason)
            emitLine(["visible": reason == nil, "reason": reason as Any])
        }
    }
    poll()
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + .milliseconds(pollIntervalMs), repeating: .milliseconds(pollIntervalMs))
    timer.setEventHandler(handler: poll)
    timer.resume()
    // The parent closing stdin is the stop signal. It is also what happens
    // when the parent dies, however it dies, so no watcher outlives the app.
    DispatchQueue.global().async {
        while readLine() != nil {}
        exit(0)
    }
    dispatchMain()

default:
    fail("unknown command \(command)")
}
