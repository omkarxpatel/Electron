//
//  Core Audio process-tap spike.
//
//  Answers one question: if we create a process tap and wrap it in an
//  aggregate device, does that device show up as a normal audio INPUT that
//  `navigator.mediaDevices.enumerateDevices()` can open from Electron?
//
//  If yes, the app's existing getUserMedia({ deviceId }) path works unchanged
//  and BlackHole becomes optional instead of required. If no, we need to pipe
//  PCM out of a helper process instead, which is a much larger change.
//
//  Deliberately NOT wired into the app. Build + run it by hand.
//
//  Usage:
//    tapspike --list                 # enumerate audio devices, exit
//    tapspike                        # global tap, unmuted, public aggregate
//    tapspike --mute                 # mute tapped processes (Live-mode shape)
//    tapspike --private              # mark the aggregate device private
//    tapspike --exclude-pid 1234     # global tap MINUS that pid
//
//  Note: a bare CLI has no bundle, so macOS attributes the "System Audio
//  Recording" permission to the *terminal* running it, not to this binary.
//  That's the same attribution rule Electron's docs call out.
//

import AudioToolbox
import CoreAudio
import Foundation

setvbuf(stdout, nil, _IONBF, 0)

// MARK: - Error plumbing

enum SpikeError: Error, CustomStringConvertible {
    case os(String, OSStatus)
    case msg(String)

    var description: String {
        switch self {
        case let .os(what, st): return "\(what) failed — OSStatus \(st) \(fourCC(st))"
        case let .msg(m): return m
        }
    }
}

/// Render an OSStatus as its four-char code when printable — Core Audio errors
/// are almost always FourCC ('!obj', 'nope', …) and unreadable as decimals.
func fourCC(_ v: OSStatus) -> String {
    let n = UInt32(bitPattern: v)
    let bytes = [UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff),
                 UInt8((n >> 8) & 0xff), UInt8(n & 0xff)]
    guard let s = String(bytes: bytes, encoding: .ascii),
          s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == " " || $0 == "!" || $0 == "?") })
    else { return "" }
    return "('\(s)')"
}

func check(_ status: OSStatus, _ what: String) throws {
    guard status == noErr else { throw SpikeError.os(what, status) }
}

// MARK: - Core Audio property helpers

let systemObject = AudioObjectID(kAudioObjectSystemObject)

func address(_ selector: AudioObjectPropertySelector,
             _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal)
    -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector,
                               mScope: scope,
                               mElement: kAudioObjectPropertyElementMain)
}

func translatePIDToObject(_ pid: pid_t) throws -> AudioObjectID {
    var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
    var inPID = pid
    var out = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try check(AudioObjectGetPropertyData(systemObject, &addr,
                                         UInt32(MemoryLayout<pid_t>.size), &inPID,
                                         &size, &out),
              "TranslatePIDToProcessObject(pid: \(pid))")
    return out
}

func defaultOutputDevice() throws -> AudioObjectID {
    var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
    var out = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try check(AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &out),
              "DefaultOutputDevice")
    return out
}

/// CoreAudio hands back a +1 CFStringRef for name/UID selectors, so take the
/// retained value rather than aliasing a Swift CFString var (which would form
/// a raw pointer over an object reference).
func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var out: Unmanaged<CFString>?
    let status = withUnsafeMutablePointer(to: &out) {
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
    }
    guard status == noErr, let cf = out else { return nil }
    return cf.takeRetainedValue() as String
}

func allDeviceIDs() throws -> [AudioObjectID] {
    var addr = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    try check(AudioObjectGetPropertyDataSize(systemObject, &addr, 0, nil, &size), "DevicesSize")
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    try check(AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &ids), "Devices")
    return ids
}

/// A device is openable as an input only if it exposes input-scope streams.
/// Channel count alone lies for aggregates mid-construction.
func inputStreamCount(_ id: AudioObjectID) -> Int {
    var addr = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr else { return 0 }
    return Int(size) / MemoryLayout<AudioObjectID>.size
}

func describeDevices(highlightUID: String? = nil) {
    guard let ids = try? allDeviceIDs() else {
        print("  (could not enumerate devices)")
        return
    }
    for id in ids {
        let name = stringProperty(id, kAudioObjectPropertyName) ?? "?"
        let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) ?? "?"
        let ins = inputStreamCount(id)
        let marker = (highlightUID != nil && uid == highlightUID!) ? "  <<< OURS" : ""
        let kind = ins > 0 ? "INPUT (\(ins) stream\(ins == 1 ? "" : "s"))" : "output-only"
        print("  [\(id)] \(name)  —  \(kind)\n        uid: \(uid)\(marker)")
    }
}

/// The tap NAME we stamp on every description, so cleanup can recognise our
/// own leaked taps and leave other apps' taps alone.
let tapName = "AV Tap Spike"

/// Destroy leaked process taps left behind by a hard kill.
///
/// This is the one that actually matters. A leaked aggregate device is merely
/// confusing — it enumerates and returns silence. A leaked tap created with
/// `.muted` keeps muting audio at the PROCESS level, upstream of every output
/// device, so the machine stays silent no matter which output the user picks
/// (built-in, AirPods, anything). Sweeping only aggregates and reporting
/// "clean" is how this got missed once already.
///
/// Matched by name so we never destroy a tap belonging to another app.
func destroyLeakedTaps(named name: String) -> Int {
    var a = address(kAudioHardwarePropertyTapList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(systemObject, &a, 0, nil, &size) == noErr,
          size > 0 else { return 0 }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(systemObject, &a, 0, nil, &size, &ids) == noErr else { return 0 }

    var destroyed = 0
    for id in ids where stringProperty(id, kAudioObjectPropertyName) == name {
        if AudioHardwareDestroyProcessTap(id) == noErr { destroyed += 1 }
    }
    return destroyed
}

/// SIGKILL leaves the aggregate device registered with coreaudiod even though
/// its tap is gone — the device then shows up in enumerateDevices() and
/// delivers pure silence, which is a very convincing false negative. Sweep any
/// device matching our UID before creating a new one.
func destroyLeakedAggregates(uid: String) -> Int {
    guard let ids = try? allDeviceIDs() else { return 0 }
    var destroyed = 0
    for id in ids where stringProperty(id, kAudioDevicePropertyDeviceUID) == uid {
        if AudioHardwareDestroyAggregateDevice(id) == noErr { destroyed += 1 }
    }
    return destroyed
}

/// Peak amplitude seen by the self-test IOProc. A C function pointer can't
/// capture context, so this has to be global.
nonisolated(unsafe) var selfTestPeak: Float = 0
nonisolated(unsafe) var selfTestFrames: Int = 0

nonisolated(unsafe) var selfTestCallbacks: Int = 0
nonisolated(unsafe) var selfTestBuffers: Int = 0
nonisolated(unsafe) var selfTestBytes: Int = 0
nonisolated(unsafe) var selfTestNilData: Int = 0

let selfTestIOProc: AudioDeviceIOProc = { _, _, inInputData, _, _, _, _ in
    selfTestCallbacks += 1
    let list = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: inInputData))
    for buffer in list {
        selfTestBuffers += 1
        selfTestBytes += Int(buffer.mDataByteSize)
        guard let raw = buffer.mData else { selfTestNilData += 1; continue }
        let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
        let samples = raw.bindMemory(to: Float.self, capacity: count)
        for i in 0 ..< count {
            let v = abs(samples[i])
            if v > selfTestPeak { selfTestPeak = v }
        }
        selfTestFrames += count
    }
    return noErr
}

/// Print the device's input-scope stream format so we know the sample type
/// before interpreting buffers as Float32.
func printInputFormat(_ device: AudioObjectID) {
    var addr = address(kAudioStreamPropertyVirtualFormat, kAudioObjectPropertyScopeInput)
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    if AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &asbd) == noErr {
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        print("  input format: \(asbd.mSampleRate) Hz, \(asbd.mChannelsPerFrame) ch, \(asbd.mBitsPerChannel)-bit, float=\(isFloat)")
    } else {
        var a2 = address(kAudioDevicePropertyStreamFormat, kAudioObjectPropertyScopeInput)
        var d2 = AudioStreamBasicDescription()
        var s2 = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        if AudioObjectGetPropertyData(device, &a2, 0, nil, &s2, &d2) == noErr {
            let isFloat = d2.mFormatFlags & kAudioFormatFlagIsFloat != 0
            print("  input format (device): \(d2.mSampleRate) Hz, \(d2.mChannelsPerFrame) ch, \(d2.mBitsPerChannel)-bit, float=\(isFloat)")
        } else {
            print("  input format: unavailable")
        }
    }
}

/// Read the aggregate for `seconds` and report whether any non-zero sample
/// arrived. This is the ground truth for "does the tap actually deliver audio".
func runSelfTest(device: AudioObjectID, seconds: Double) {
    var procID: AudioDeviceIOProcID?
    let created = AudioDeviceCreateIOProcID(device, selfTestIOProc, nil, &procID)
    guard created == noErr, let procID else {
        print("selftest: CreateIOProcID failed — OSStatus \(created) \(fourCC(created))")
        return
    }
    let started = AudioDeviceStart(device, procID)
    guard started == noErr else {
        print("selftest: AudioDeviceStart failed — OSStatus \(started) \(fourCC(started))")
        _ = AudioDeviceDestroyIOProcID(device, procID)
        return
    }
    printInputFormat(device)
    print("selftest: reading for \(seconds)s …")
    Thread.sleep(forTimeInterval: seconds)
    _ = AudioDeviceStop(device, procID)
    _ = AudioDeviceDestroyIOProcID(device, procID)
    print("""
    selftest: callbacks=\(selfTestCallbacks) buffers=\(selfTestBuffers) bytes=\(selfTestBytes) \
    nilData=\(selfTestNilData) samples=\(selfTestFrames)
    selftest: peak=\(selfTestPeak)  delivered=\(selfTestPeak > 0.0001)
    """)
}

// MARK: - Arguments

let args = CommandLine.arguments
func hasFlag(_ f: String) -> Bool { args.contains(f) }
func intValue(_ f: String) -> Int32? {
    guard let i = args.firstIndex(of: f), i + 1 < args.count else { return nil }
    return Int32(args[i + 1])
}

if hasFlag("--list") {
    if let out = try? defaultOutputDevice() {
        print("default OUTPUT: \(stringProperty(out, kAudioObjectPropertyName) ?? "?") [\(out)]")
    }
    if let inp = try? { () -> AudioObjectID in
        var addr = address(kAudioHardwarePropertyDefaultInputDevice)
        var id = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        try check(AudioObjectGetPropertyData(systemObject, &addr, 0, nil, &size, &id), "DefaultInput")
        return id
    }() {
        print("default INPUT:  \(stringProperty(inp, kAudioObjectPropertyName) ?? "?") [\(inp)]")
    }
    print("Audio devices:")
    describeDevices()
    exit(0)
}

// Read any existing device by UID substring — lets us compare the tap against
// a known-good reference (e.g. BlackHole) without Chromium in the path.
if let i = args.firstIndex(of: "--read-device"), i + 1 < args.count {
    let needle = args[i + 1].lowercased()
    guard let ids = try? allDeviceIDs() else { exit(1) }
    guard let match = ids.first(where: {
        let uid = (stringProperty($0, kAudioDevicePropertyDeviceUID) ?? "").lowercased()
        let name = (stringProperty($0, kAudioObjectPropertyName) ?? "").lowercased()
        return uid.contains(needle) || name.contains(needle)
    }) else {
        print("no device matching '\(needle)'")
        exit(1)
    }
    print("reading: \(stringProperty(match, kAudioObjectPropertyName) ?? "?") [\(match)] inputStreams=\(inputStreamCount(match))")
    runSelfTest(device: match, seconds: 3.0)
    exit(0)
}

if hasFlag("--cleanup") {
    let devices = destroyLeakedAggregates(uid: "com.omkar.audiovisualizer.tapspike")
    let taps = destroyLeakedTaps(named: tapName)
    print("destroyed \(devices) leaked aggregate device(s), \(taps) leaked tap(s)")
    exit(0)
}

let wantMute = hasFlag("--mute")
let wantPrivate = hasFlag("--private")
let excludePID = intValue("--exclude-pid")

// MARK: - Run

let aggregateUID = "com.omkar.audiovisualizer.tapspike"
var tapID = AudioObjectID(kAudioObjectUnknown)
var aggregateID = AudioObjectID(kAudioObjectUnknown)

func teardown() {
    if aggregateID != kAudioObjectUnknown {
        let st = AudioHardwareDestroyAggregateDevice(aggregateID)
        print("teardown: destroy aggregate -> \(st == noErr ? "ok" : "OSStatus \(st) \(fourCC(st))")")
    }
    if tapID != kAudioObjectUnknown {
        let st = AudioHardwareDestroyProcessTap(tapID)
        print("teardown: destroy tap -> \(st == noErr ? "ok" : "OSStatus \(st) \(fourCC(st))")")
    }
}

do {
    print("=== Core Audio tap spike ===")
    print("mute: \(wantMute)   private aggregate: \(wantPrivate)   exclude-pid: \(excludePID.map(String.init) ?? "none")")

    // 1. Build the tap description.
    //    Empty exclusion list = tap everything. Excluding a pid that isn't
    //    currently playing audio fails at the translate step below, which is
    //    the documented gotcha for excluding our own (silent) process.
    var excluded: [AudioObjectID] = []
    if let pid = excludePID {
        let obj = try translatePIDToObject(pid)
        print("resolved pid \(pid) -> AudioObjectID \(obj)")
        excluded = [obj]
    }

    let sweptDevices = destroyLeakedAggregates(uid: aggregateUID)
    let sweptTaps = destroyLeakedTaps(named: tapName)
    if sweptDevices > 0 || sweptTaps > 0 {
        print("swept \(sweptDevices) leaked aggregate device(s), \(sweptTaps) leaked tap(s) from a previous run")
    }

    let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
    desc.name = tapName
    // A private tap is readable ONLY by the process that created it. Chromium
    // reads audio in a separate audio-service process, so a private tap here
    // yields a device that appears in enumerateDevices() but delivers pure
    // silence. Public by default; --private-tap to demonstrate the failure.
    desc.isPrivate = hasFlag("--private-tap")
    let behavior: CATapMuteBehavior = wantMute ? .muted : .unmuted
    desc.muteBehavior = behavior
    print("tap description uuid: \(desc.uuid.uuidString)")

    // 2. Create the tap.
    try check(AudioHardwareCreateProcessTap(desc, &tapID), "AudioHardwareCreateProcessTap")
    print("tap created: AudioObjectID \(tapID)")

    // 3. Wrap it in an aggregate device. The default output device rides along
    //    as the main sub-device so the aggregate inherits a valid clock.
    let outputID = try defaultOutputDevice()
    guard let outputUID = stringProperty(outputID, kAudioDevicePropertyDeviceUID) else {
        throw SpikeError.msg("could not read default output device UID")
    }
    print("clock anchor: \(stringProperty(outputID, kAudioObjectPropertyName) ?? "?") (\(outputUID))")

    let dict: [String: Any] = [
        kAudioAggregateDeviceNameKey: "AV Tap Spike",
        kAudioAggregateDeviceUIDKey: aggregateUID,
        kAudioAggregateDeviceMainSubDeviceKey: outputUID,
        kAudioAggregateDeviceIsPrivateKey: wantPrivate,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceSubDeviceListKey: hasFlag("--no-subdevice")
            ? []
            : [[kAudioSubDeviceUIDKey: outputUID]],
        kAudioAggregateDeviceTapListKey: [
            [
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: desc.uuid.uuidString,
            ],
        ],
    ]

    try check(AudioHardwareCreateAggregateDevice(dict as CFDictionary, &aggregateID),
              "AudioHardwareCreateAggregateDevice")
    print("aggregate created: AudioObjectID \(aggregateID)")
    print("aggregate input streams: \(inputStreamCount(aggregateID))")

    if hasFlag("--selftest") {
        runSelfTest(device: aggregateID, seconds: 3.0)
        // Self-test is a one-shot measurement, not an interactive session.
        teardown()
        exit(0)
    }

    print("\n--- devices while tap is alive ---")
    describeDevices(highlightUID: aggregateUID)

    print("""

    Now check visibility from the renderer. In the app's DevTools console:

      (await navigator.mediaDevices.enumerateDevices())
        .filter(d => d.kind === 'audioinput')
        .map(d => d.label)

    Looking for "AV Tap Spike". Ctrl-C here to tear down.
    """)

    for sig in [SIGINT, SIGTERM] {
        signal(sig) { _ in
            print("\ncaught signal — tearing down")
            teardown()
            exit(0)
        }
    }
    RunLoop.current.run()
} catch {
    print("\nERROR: \(error)")
    if case let SpikeError.os(what, _) = error, what.hasPrefix("AudioHardwareCreateProcessTap") {
        print("""

        Tap creation failing usually means the System Audio Recording
        permission is missing. Because this is a bare CLI, macOS attributes
        that permission to the terminal app running it — grant it under
        System Settings > Privacy & Security > System Audio Recording.
        """)
    }
    teardown()
    exit(1)
}
