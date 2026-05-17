import { useEffect, useRef } from 'react';

/**
 * Auto-picks audio input + output devices on app start.
 *
 *  - Input: BlackHole 2ch (the user's standard system-audio capture route).
 *           Falls back to any BlackHole channel count if 2ch isn't installed.
 *
 *  - Output: prefers any non-built-in physical output (likely a connected
 *           Bluetooth device or wired headphones), falling back to MacBook
 *           speakers. Virtual sinks (BlackHole, aggregates) are excluded so
 *           the processed audio doesn't feed back into capture.
 *
 * Attempts run once per mount via a ref guard, but re-trigger on `devicechange`
 * until both succeed — that's what handles the "permission granted after
 * app start" path (enumerateDevices returns blank labels without permission).
 */

interface Params {
  onUseDevice: (id: string) => void;
  onSelectOutput: (id: string | null) => void;
}

export function useAutoSelectDevices({ onUseDevice, onSelectOutput }: Params) {
  const attemptedRef = useRef({ input: false, output: false });

  useEffect(() => {
    let cancelled = false;

    async function attempt() {
      if (attemptedRef.current.input && attemptedRef.current.output) return;

      let devices: MediaDeviceInfo[];
      try {
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        return;
      }
      if (cancelled) return;

      const inputs = devices.filter((d) => d.kind === 'audioinput');
      const outputs = devices.filter((d) => d.kind === 'audiooutput');

      // Without microphone permission, labels are empty — we can't match by
      // name. Skip silently; the devicechange listener will re-trigger this
      // once labels become available.
      const hasLabels = inputs.some((d) => !!d.label) || outputs.some((d) => !!d.label);
      if (!hasLabels) return;

      if (!attemptedRef.current.input) {
        const blackhole = pickBlackHole(inputs);
        if (blackhole) {
          attemptedRef.current.input = true;
          onUseDevice(blackhole.deviceId);
        }
      }

      if (!attemptedRef.current.output) {
        const out = pickBestOutput(outputs);
        if (out) {
          attemptedRef.current.output = true;
          onSelectOutput(out.deviceId);
        }
      }
    }

    void attempt();
    const handler = () => void attempt();
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', handler);
    };
  }, [onUseDevice, onSelectOutput]);
}

function pickBlackHole(inputs: MediaDeviceInfo[]): MediaDeviceInfo | null {
  // Prefer 2ch specifically; fall back to any BlackHole channel variant.
  return (
    inputs.find((d) => /blackhole[\s_-]*2\s*ch/i.test(d.label)) ??
    inputs.find((d) => /blackhole/i.test(d.label)) ??
    null
  );
}

function pickBestOutput(outputs: MediaDeviceInfo[]): MediaDeviceInfo | null {
  // Drop the "default" / "communications" pseudo-aliases — they collapse to
  // a real device anyway and using them defeats the purpose of explicit routing.
  const real = outputs.filter(
    (d) =>
      d.deviceId !== 'default' &&
      d.deviceId !== 'communications' &&
      !isVirtualSink(d.label),
  );
  // Prefer anything that isn't the built-in laptop speakers. macOS doesn't
  // expose a transport flag, so we go by exclusion: anything that isn't
  // labeled "MacBook" is treated as Bluetooth/USB/wired headphones — all
  // valid "real output" choices for an app whose input is BlackHole.
  const external = real.find((d) => !isBuiltInLaptopSpeakers(d.label));
  if (external) return external;
  return real.find((d) => isBuiltInLaptopSpeakers(d.label)) ?? real[0] ?? null;
}

function isVirtualSink(label: string): boolean {
  return /blackhole|aggregate|multi-?output|loopback|soundflower/i.test(label);
}

function isBuiltInLaptopSpeakers(label: string): boolean {
  return /macbook/i.test(label) && /speaker/i.test(label);
}
