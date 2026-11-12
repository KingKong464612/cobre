export type Waveform = "sine" | "square" | "sawtooth" | "triangle";

export type Settings = {
  waveform: Waveform;
  cutoff: number;
  resonance: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  volume: number;
  octave: number;
};

export const DEFAULT_SETTINGS: Settings = {
  waveform: "sawtooth",
  cutoff: 2200,
  resonance: 0.9,
  attack: 0.02,
  decay: 0.2,
  sustain: 0.65,
  release: 0.3,
  volume: 0.78,
  octave: 4,
};

export const OCTAVE_MIN = 2;
export const OCTAVE_MAX = 6;
/** Inclusive semitone span from the root: C to the C two octaves up. */
export const KEYBOARD_END = 24;

export const CODE_TO_SEMI: Record<string, number> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
  KeyO: 13,
  KeyL: 14,
  KeyP: 15,
  Semicolon: 16,
  Quote: 17,
};

export const SEMI_LABEL: Record<number, string> = {
  0: "A",
  1: "W",
  2: "S",
  3: "E",
  4: "D",
  5: "F",
  6: "T",
  7: "G",
  8: "Y",
  9: "H",
  10: "U",
  11: "J",
  12: "K",
  13: "O",
  14: "L",
  15: "P",
  16: "Ñ",
  17: "´",
};

const NAMES = ["Do", "Do♯", "Re", "Re♯", "Mi", "Fa", "Fa♯", "Sol", "Sol♯", "La", "La♯", "Si"] as const;

const WAVES: Waveform[] = ["sine", "square", "sawtooth", "triangle"];

export const WAVEFORMS: { id: Waveform; label: string }[] = [
  { id: "sine", label: "Seno" },
  { id: "square", label: "Cuadrada" },
  { id: "sawtooth", label: "Sierra" },
  { id: "triangle", label: "Triángulo" },
];

const STORAGE_KEY = "cobre-settings-v1";

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function midiFromOctave(octave: number, semi: number) {
  return (octave + 1) * 12 + semi;
}

export function isBlackSemi(semi: number) {
  const n = ((semi % 12) + 12) % 12;
  return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
}

export function pitchName(midi: number) {
  const name = NAMES[((midi % 12) + 12) % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${name} ${oct}`;
}

export function noteLabel(midi: number) {
  const name = NAMES[((midi % 12) + 12) % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${name}${oct}`;
}

export function expMap(t: number, min: number, max: number) {
  const x = clamp(t, 0, 1);
  return min * (max / min) ** x;
}

export function expUnmap(value: number, min: number, max: number) {
  const v = clamp(value, min, max);
  return Math.log(v / min) / Math.log(max / min);
}

export function formatHz(hz: number) {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${k >= 10 ? k.toFixed(0) : k.toFixed(1)} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

export function formatSecs(seconds: number) {
  if (seconds < 0.1) return `${Math.round(seconds * 1000)} ms`;
  return `${seconds.toFixed(2)} s`;
}

function num(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function sanitize(parsed: Partial<Settings>): Settings {
  const waveform = WAVES.includes(parsed.waveform as Waveform)
    ? (parsed.waveform as Waveform)
    : DEFAULT_SETTINGS.waveform;
  return {
    waveform,
    cutoff: clamp(num(parsed.cutoff, DEFAULT_SETTINGS.cutoff), 80, 14000),
    resonance: clamp(num(parsed.resonance, DEFAULT_SETTINGS.resonance), 0.35, 12),
    attack: clamp(num(parsed.attack, DEFAULT_SETTINGS.attack), 0.005, 1.4),
    decay: clamp(num(parsed.decay, DEFAULT_SETTINGS.decay), 0.02, 1.8),
    sustain: clamp(num(parsed.sustain, DEFAULT_SETTINGS.sustain), 0, 1),
    release: clamp(num(parsed.release, DEFAULT_SETTINGS.release), 0.02, 2.4),
    volume: clamp(num(parsed.volume, DEFAULT_SETTINGS.volume), 0, 1),
    octave: Math.round(clamp(num(parsed.octave, DEFAULT_SETTINGS.octave), OCTAVE_MIN, OCTAVE_MAX)),
  };
}

export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return sanitize(JSON.parse(raw) as Partial<Settings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* quota or private mode */
  }
}
