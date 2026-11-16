// ── Learning mute flag ─────────────────────────────────────────────────
// Persisted so a crash during a learning run cannot leave the next launch
// playing a silent run out loud. Written BEFORE muting and cleared only AFTER
// unmuting: the other order opens a window where a crash leaves music audible
// with nothing on disk saying it should be muted.

const STORAGE_KEY = 'av.learner.muted.v1';

export function readLearnMuteFlag(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLearnMuteFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or a full disk. The run still mutes in memory; only the
    // crash recovery is lost.
  }
}
