import type { Settings } from "@/lib/synth/notes";

type Voice = {
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
};

const PEAK = 0.18;

export class SynthEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private wave: Uint8Array<ArrayBuffer> | null = null;
  private voices = new Map<number, Voice>();
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  get running() {
    return this.ctx?.state === "running";
  }

  update(settings: Settings) {
    this.settings = settings;
    this.applyLive();
  }

  start(): Promise<boolean> {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return Promise.resolve(false);
    if (!this.ctx) {
      this.ctx = new Ctx();
      this.build(this.ctx);
    }
    const ctx = this.ctx;
    if (ctx.state === "running") return Promise.resolve(true);
    return ctx.resume().then(
      () => ctx.state === "running",
      () => false,
    );
  }

  async stop() {
    this.allOff();
    if (this.ctx && this.ctx.state === "running") await this.ctx.suspend();
  }

  noteOn(midi: number) {
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    if (this.voices.has(midi)) this.noteOff(midi, true);
    if (this.voices.size >= 16) {
      const oldest = this.voices.keys().next().value;
      if (oldest !== undefined) this.noteOff(oldest, true);
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = this.settings.waveform;
    osc.frequency.setValueAtTime(440 * 2 ** ((midi - 69) / 12), now);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(this.settings.cutoff, now);
    filter.Q.setValueAtTime(this.settings.resonance, now);

    const gain = ctx.createGain();
    const attack = Math.max(0.008, this.settings.attack);
    const decay = Math.max(0.02, this.settings.decay);
    const sustain = Math.max(0.0008, PEAK * this.settings.sustain);
    gain.gain.setValueAtTime(0.0008, now);
    gain.gain.exponentialRampToValueAtTime(PEAK, now + attack);
    gain.gain.exponentialRampToValueAtTime(sustain, now + attack + decay);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    this.voices.set(midi, { osc, filter, gain });
  }

  noteOff(midi: number, fast = false) {
    const voice = this.voices.get(midi);
    if (!voice || !this.ctx) return;
    this.voices.delete(midi);
    const now = this.ctx.currentTime;
    const release = fast ? 0.035 : Math.max(0.02, this.settings.release);
    const gain = voice.gain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(Math.max(0.0008, gain.value), now);
    gain.exponentialRampToValueAtTime(0.0008, now + release);
    try {
      voice.osc.stop(now + release + 0.04);
    } catch {
      /* oscillator already stopped */
    }
    window.setTimeout(() => {
      voice.osc.disconnect();
      voice.filter.disconnect();
      voice.gain.disconnect();
    }, (release + 0.08) * 1000);
  }

  allOff() {
    for (const midi of [...this.voices.keys()]) this.noteOff(midi, true);
  }

  sample(): { wave: Uint8Array<ArrayBuffer>; level: number } | null {
    if (!this.analyser || !this.wave || !this.running) return null;
    this.analyser.getByteTimeDomainData(this.wave);
    let sum = 0;
    const data = this.wave;
    const stride = 4;
    let count = 0;
    for (let i = 0; i < data.length; i += stride) {
      const n = (data[i] - 128) / 128;
      sum += n * n;
      count += 1;
    }
    const rms = Math.sqrt(sum / Math.max(1, count));
    return { wave: data, level: Math.min(1, rms * 4.4) };
  }

  dispose() {
    this.allOff();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.analyser = null;
    this.wave = null;
  }

  private build(ctx: AudioContext) {
    const master = ctx.createGain();
    master.gain.value = this.outputGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 18;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.68;
    master.connect(comp);
    comp.connect(analyser);
    analyser.connect(ctx.destination);
    this.master = master;
    this.analyser = analyser;
    this.wave = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  }

  private outputGain() {
    return this.settings.volume ** 2;
  }

  private applyLive() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.outputGain(), t, 0.03);
    for (const voice of this.voices.values()) {
      voice.osc.type = this.settings.waveform;
      voice.filter.frequency.setTargetAtTime(this.settings.cutoff, t, 0.035);
      voice.filter.Q.setTargetAtTime(this.settings.resonance, t, 0.035);
    }
  }
}
