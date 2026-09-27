// Per-device output volume, read and written without disturbing the default
// device.
//
// This exists because the macOS volume slider only ever targets the DEFAULT
// output device. Once system output is pointed at BlackHole so we can tap it,
// the device we actually play OUT of (via setSinkId) is no longer the default,
// so nothing in the UI can reach its volume — it stays frozen at whatever it
// held when the user switched away, and that frozen value becomes a hard
// ceiling on how loud the app can ever get. Measured on a real machine: a sink
// left at 20% is 50 dB down on built-in speakers and 80 dB down on AirPods.
//
// `osascript -e "set volume output volume N"` cannot fix this: it also only
// addresses the default device. CoreAudio can address any device directly,
// which is the whole reason this helper is a separate binary.
//
// Commands (all emit one line of JSON on stdout; exit 1 carries {"error":...}):
//   avvolume list
//   avvolume get <device-name>
//   avvolume set <device-name> <scalar 0..1>

import Foundation
import CoreAudio

// ── CoreAudio property plumbing ──────────────────────────────────────

/// Element 0 is the master channel. Spelled as a literal rather than
/// kAudioObjectPropertyElementMain because that constant is macOS 12+ and the
/// app ships with minimumSystemVersion 11.0; the older spelling for it is
/// deprecated, so neither name is usable across our whole support range.
private let masterElement = AudioObjectPropertyElement(0)

private func address(_ selector: AudioObjectPropertySelector,
                     _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                     _ element: AudioObjectPropertyElement = masterElement)
    -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

private let systemObject = AudioObjectID(kAudioObjectSystemObject)

private func allDeviceIDs() -> [AudioDeviceID] {
    var addr = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

private func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
    var addr = address(selector)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: Unmanaged<CFString>?
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr,
          let cf = value?.takeRetainedValue() else { return "" }
    return cf as String
}

private func outputChannelCount(_ id: AudioDeviceID) -> Int {
    var addr = address(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeOutput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size),
                                               alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

/// Where this device keeps its volume. Most expose a master control on element
/// 0, but some — AirPods among them — only have per-channel controls, so a
/// write that only touched element 0 would silently do nothing.
private func volumeElements(_ id: AudioDeviceID) -> [AudioObjectPropertyElement] {
    var master = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, masterElement)
    if AudioObjectHasProperty(id, &master) { return [masterElement] }
    var elements: [AudioObjectPropertyElement] = []
    for channel in UInt32(1)...UInt32(8) {
        var addr = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, channel)
        if AudioObjectHasProperty(id, &addr) { elements.append(channel) }
    }
    return elements
}

private func readVolume(_ id: AudioDeviceID) -> Float? {
    guard let element = volumeElements(id).first else { return nil }
    var addr = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, element)
    var value: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

/// Returns nil on success, or a human-readable reason on failure.
private func writeVolume(_ id: AudioDeviceID, _ requested: Float) -> String? {
    let elements = volumeElements(id)
    if elements.isEmpty { return "device has no output volume control" }
    var wroteAny = false
    var lastStatus: OSStatus = noErr
    for element in elements {
        var addr = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, element)
        var settable: DarwinBoolean = false
        guard AudioObjectIsPropertySettable(id, &addr, &settable) == noErr, settable.boolValue else { continue }
        var value = Float32(min(max(requested, 0), 1))
        let status = AudioObjectSetPropertyData(id, &addr, 0, nil,
                                                UInt32(MemoryLayout<Float32>.size), &value)
        if status == noErr { wroteAny = true } else { lastStatus = status }
    }
    return wroteAny ? nil : "volume is not settable on this device (status \(lastStatus))"
}

private func defaultOutputID() -> AudioDeviceID {
    var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &id)
    return id
}

// ── Output ───────────────────────────────────────────────────────────

private func emit(_ payload: [String: Any], exitCode: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
        ?? Data("{\"error\":\"could not serialise result\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode)
}

private func fail(_ message: String) -> Never { emit(["error": message], exitCode: 1) }

// ── Device lookup ────────────────────────────────────────────────────

private struct OutputDevice {
    let id: AudioDeviceID
    let name: String
    let uid: String
    let channels: Int
}

private func outputDevices() -> [OutputDevice] {
    allDeviceIDs().compactMap { id in
        let channels = outputChannelCount(id)
        guard channels > 0 else { return nil }
        return OutputDevice(id: id,
                            name: stringProperty(id, kAudioObjectPropertyName),
                            uid: stringProperty(id, kAudioDevicePropertyDeviceUID),
                            channels: channels)
    }
}

/// Match on name, because that is the only identifier the renderer has:
/// Chromium's enumerateDevices() deviceIds are per-origin salted hashes, not
/// CoreAudio UIDs, so they cannot be mapped back to a device here.
private func findOutput(named name: String) -> OutputDevice {
    let devices = outputDevices()
    if let exact = devices.first(where: { $0.name == name }) { return exact }
    // Chromium appends a transport suffix to some labels ("MacBook Pro
    // Speakers (Built-in)"), so fall back to a prefix match before giving up.
    if let prefixed = devices.first(where: { name.hasPrefix($0.name) }) { return prefixed }
    fail("no output device named \(name)")
}

// ── Entry point ──────────────────────────────────────────────────────

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: avvolume list|get <name>|set <name> <scalar>") }

switch command {
case "list":
    let current = defaultOutputID()
    emit(["devices": outputDevices().map { device -> [String: Any] in
        let volume = readVolume(device.id)
        return [
            "name": device.name,
            "uid": device.uid,
            "channels": device.channels,
            "hasVolumeControl": volume != nil,
            "volume": volume.map { Double($0) } as Any,
            "isDefaultOutput": device.id == current,
        ]
    }])

case "get":
    guard args.count >= 2 else { fail("usage: avvolume get <name>") }
    let device = findOutput(named: args[1])
    let volume = readVolume(device.id)
    emit(["name": device.name,
          "uid": device.uid,
          "hasVolumeControl": volume != nil,
          "volume": volume.map { Double($0) } as Any])

case "set":
    guard args.count >= 3, let requested = Float(args[2]) else {
        fail("usage: avvolume set <name> <scalar 0..1>")
    }
    let device = findOutput(named: args[1])
    if let reason = writeVolume(device.id, requested) { fail(reason) }
    emit(["name": device.name,
          "uid": device.uid,
          "hasVolumeControl": true,
          "volume": readVolume(device.id).map { Double($0) } as Any])

default:
    fail("unknown command \(command)")
}
