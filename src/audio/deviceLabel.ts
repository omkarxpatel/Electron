/**
 * Shared heuristics for classifying audio-device labels reported by
 * `navigator.mediaDevices.enumerateDevices()`. Used by:
 *   - useAutoSelectDevices  (filter out virtual sinks when auto-picking output)
 *   - useAudioOutput        (one-time migration to clear stale virtual choices)
 *
 * macOS's enumerateDevices() doesn't expose a transport flag, so we go by
 * label matching. The patterns below cover the common virtual-routing drivers
 * and meeting-tool audio devices that frequently sneak into a user's output
 * choice without them noticing.
 */

export function isVirtualSink(label: string): boolean {
  // Catches:
  //   - classic virtual-routing drivers (BlackHole, Aggregate, Multi-Output,
  //     Soundflower, Loopback)
  //   - anything macOS tags with "(Virtual)" — covers Microsoft Teams,
  //     Zoom, Discord meeting drivers etc.
  //   - specific known processing drivers that don't always include
  //     "(Virtual)" in their label
  return /blackhole|aggregate|multi-?output|soundflower|loopback|\(virtual\)|teams audio|zoom audio|krisp|background music|ndi|webex audio|discord/i.test(
    label,
  );
}

export function isBuiltInLaptopSpeakers(label: string): boolean {
  return /macbook/i.test(label) && /speaker/i.test(label);
}
