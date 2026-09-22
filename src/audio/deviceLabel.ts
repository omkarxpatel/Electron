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
  //   - the Windows equivalents (second alternation below). Every term there
  //     is either Windows-only ("Stereo Mix", VoiceMeeter, NVIDIA Broadcast)
  //     or names a device that is genuinely virtual on macOS too (VB-Cable,
  //     Elgato Wave Link, Steam streaming), so adding them cannot change how
  //     a real macOS device is classified.
  return (
    /blackhole|aggregate|multi-?output|soundflower|loopback|\(virtual\)|teams audio|zoom audio|krisp|background music|ndi|webex audio|discord/i.test(
      label,
    ) ||
    /stereo mix|vb-?audio|cable input|cable output|virtual audio|voicemeeter|wave link|nvidia broadcast|steam streaming|obs virtual/i.test(
      label,
    )
  );
}

export function isBuiltInLaptopSpeakers(label: string): boolean {
  // macOS: "MacBook Pro Speakers".
  if (/macbook/i.test(label) && /speaker/i.test(label)) return true;
  // Windows names the onboard codec instead: "Speakers (Realtek(R) Audio)",
  // "Speakers (High Definition Audio Device)", "Speakers (Intel® Smart Sound
  // Technology)". Requiring /speaker/ as well deliberately excludes the
  // built-in HEADPHONE jack ("Headphones (Realtek(R) Audio)") — the user
  // plugged something in there, so it should stay preferable, mirroring how
  // macOS treats "External Headphones".
  return (
    /speaker/i.test(label) &&
    /realtek|high definition audio|smart sound|amd audio|nvidia high definition/i.test(
      label,
    )
  );
}
