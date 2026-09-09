/**
 * A short two-tone chime, synthesised — no bundled asset, no network.
 *
 * WKWebView may refuse to start an AudioContext before a user gesture has
 * happened in the page; `resume()` is attempted and any failure is swallowed,
 * so a chime that cannot play costs nothing.
 */
let ctx: AudioContext | null = null;

export function playChime(): void {
  try {
    ctx ??= new AudioContext();
    const ac = ctx;
    void ac.resume().catch(() => {});
    const now = ac.currentTime;
    const tone = (freq: number, at: number) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain).connect(ac.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    };
    tone(880, now);
    tone(1174.66, now + 0.12);
  } catch {
    // No audio — fine.
  }
}
