let sharedAudioCtx: AudioContext | null = null;

/**
 * Synthesizes a subtle, crisp mechanical camera shutter SFX using Web Audio API.
 */
export function playCaptureShutter(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;

    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new AudioCtx();
    }
    const ctx = sharedAudioCtx;
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const now = ctx.currentTime;

    // 1. Crisp first-curtain band-pass noise snap (~2400 Hz, 28ms)
    const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * 0.032));
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      const env = Math.exp((-i / bufferSize) * 7.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(2400, now);
    bp.Q.setValueAtTime(1.6, now);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.16, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.028);

    noiseSrc.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noiseSrc.start(now);

    // 2. Subtle low-end shutter body thump (260 -> 90 Hz, 26ms)
    const osc1 = ctx.createOscillator();
    osc1.type = "triangle";
    osc1.frequency.setValueAtTime(260, now);
    osc1.frequency.exponentialRampToValueAtTime(90, now + 0.026);

    const osc1Gain = ctx.createGain();
    osc1Gain.gain.setValueAtTime(0.1, now);
    osc1Gain.gain.exponentialRampToValueAtTime(0.001, now + 0.026);

    osc1.connect(osc1Gain);
    osc1Gain.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.028);

    // 3. Soft second-curtain mechanical tick at +48ms
    const t2 = now + 0.048;
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(3800, t2);
    osc2.frequency.exponentialRampToValueAtTime(1600, t2 + 0.018);

    const osc2Gain = ctx.createGain();
    osc2Gain.gain.setValueAtTime(0.06, t2);
    osc2Gain.gain.exponentialRampToValueAtTime(0.001, t2 + 0.018);

    osc2.connect(osc2Gain);
    osc2Gain.connect(ctx.destination);
    osc2.start(t2);
    osc2.stop(t2 + 0.02);
  } catch {
    // Ignore audio context errors so capture flow is never blocked
  }
}
