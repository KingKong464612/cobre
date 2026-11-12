import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Minus, Plus, Power } from "lucide-react";
import { SynthEngine } from "@/lib/synth/engine";
import {
  CODE_TO_SEMI,
  DEFAULT_SETTINGS,
  KEYBOARD_END,
  OCTAVE_MAX,
  OCTAVE_MIN,
  SEMI_LABEL,
  WAVEFORMS,
  clamp,
  expMap,
  expUnmap,
  formatHz,
  formatSecs,
  isBlackSemi,
  loadSettings,
  midiFromOctave,
  noteLabel,
  pitchName,
  saveSettings,
  type Settings,
  type Waveform,
} from "@/lib/synth/notes";

const CUTOFF = { min: 80, max: 14000 };
const RESONANCE = { min: 0.35, max: 12 };
const ATTACK = { min: 0.005, max: 1.4 };
const DECAY = { min: 0.02, max: 1.8 };
const RELEASE = { min: 0.02, max: 2.4 };

const SCOPE_FLAT = "0,50 100,50";

function scopePoints(data: Uint8Array<ArrayBuffer> | null) {
  if (!data) return SCOPE_FLAT;
  const stride = 8;
  const count = Math.ceil(data.length / stride);
  let text = "";
  let index = 0;
  for (let i = 0; i < data.length; i += stride) {
    const x = (index / (count - 1)) * 100;
    const y = (1 - data[i] / 255) * 100;
    text += `${x.toFixed(1)},${y.toFixed(1)} `;
    index += 1;
  }
  return text;
}

function isControlTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("[data-knob], input, textarea, select"));
}

function midiAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y);
  const key = el?.closest<HTMLElement>("[data-midi]");
  if (!key) return null;
  const midi = Number(key.dataset.midi);
  return Number.isFinite(midi) ? midi : null;
}

function buildKeys(octave: number) {
  const base = midiFromOctave(octave, 0);
  const whites: { midi: number; semi: number }[] = [];
  const blacks: { midi: number; semi: number; slot: number }[] = [];
  let seen = 0;
  for (let semi = 0; semi <= KEYBOARD_END; semi += 1) {
    const midi = base + semi;
    if (isBlackSemi(semi)) blacks.push({ midi, semi, slot: seen });
    else {
      whites.push({ midi, semi });
      seen += 1;
    }
  }
  return { whites, blacks, whiteCount: seen };
}

function WaveIcon({ id }: { id: Waveform }) {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg viewBox="0 0 32 16" className="h-4 w-8" aria-hidden="true">
      {id === "sine" && <path {...stroke} d="M1 8c2.6-6 5.2-6 7.8 0s5.2 6 7.8 0 5.2-6 7.8 0 5-6 6.6 0" />}
      {id === "square" && <path {...stroke} d="M1 12V4h7.5v8H16V4h7.5v8H31" />}
      {id === "sawtooth" && <path {...stroke} d="M1 12 9 4v8l8-8v8l8-8v8l6-6" />}
      {id === "triangle" && <path {...stroke} d="M1 12 9 4l8 8 8-8 6 6" />}
    </svg>
  );
}

function Knob({
  label,
  value,
  display,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  onChange: (next: number) => void;
}) {
  const drag = useRef<{ id: number; y: number; v: number } | null>(null);
  const angle = -140 + value * 280;

  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <button
        type="button"
        data-knob
        className="knob"
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-valuetext={display}
        aria-orientation="vertical"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, y: event.clientY, v: value };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          const sens = event.shiftKey ? 420 : 150;
          onChange(clamp(current.v + (current.y - event.clientY) / sens, 0, 1));
        }}
        onPointerUp={(event) => {
          if (drag.current?.id === event.pointerId) drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.01 : 0.04;
          if (event.key === "Home") onChange(0);
          else if (event.key === "End") onChange(1);
          else if (event.key === "ArrowUp" || event.key === "ArrowRight") onChange(clamp(value + step, 0, 1));
          else if (event.key === "ArrowDown" || event.key === "ArrowLeft") onChange(clamp(value - step, 0, 1));
          else return;
          event.preventDefault();
        }}
      >
        <span className="knob-rotor" style={{ transform: `rotate(${angle}deg)` }}>
          <span className="knob-tick" />
        </span>
      </button>
      <span className="max-w-full text-center text-xs font-medium text-muted">{label}</span>
      <span className="text-sm text-paper tabular-nums">{display}</span>
    </div>
  );
}

function Scope({
  engineRef,
  armed,
  voices,
}: {
  engineRef: RefObject<SynthEngine | null>;
  armed: boolean;
  voices: number;
}) {
  const waveRef = useRef<SVGPolylineElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const armedRef = useRef(armed);
  armedRef.current = armed;

  useEffect(() => {
    let frame = 0;
    let level = 0;
    let peak = 0;
    let lastAria = 0;
    const loop = (time: number) => {
      frame = window.requestAnimationFrame(loop);
      const sample = armedRef.current ? (engineRef.current?.sample() ?? null) : null;
      const target = sample?.level ?? 0;
      level += (target - level) * 0.38;
      if (level > peak) peak = level;
      else peak = Math.max(0, peak - 0.008);
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${Math.min(1, level)})`;
      if (peakRef.current) peakRef.current.style.left = `${Math.min(99.4, peak * 100)}%`;
      if (meterRef.current && time - lastAria > 250) {
        meterRef.current.setAttribute("aria-valuenow", String(Math.round(level * 100)));
        lastAria = time;
      }
      waveRef.current?.setAttribute("points", scopePoints(sample?.wave ?? null));
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, [engineRef]);

  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_13rem] md:items-end">
      <div>
        <h2 className="text-xs font-medium tracking-widest text-muted uppercase">Osciloscopio</h2>
        <div className="scope-bezel mt-2">
          <svg className="scope-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <g className="scope-grid">
              <line x1="0" y1="25" x2="100" y2="25" />
              <line x1="0" y1="50" x2="100" y2="50" />
              <line x1="0" y1="75" x2="100" y2="75" />
            </g>
            <polyline ref={waveRef} points={SCOPE_FLAT} />
          </svg>
          {!armed && <p className="scope-wait">La traza aparece al encender</p>}
        </div>
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xs font-medium tracking-widest text-muted uppercase">Nivel</h2>
          <p className="text-xs text-muted tabular-nums">
            {voices} {voices === 1 ? "voz" : "voces"}
          </p>
        </div>
        <div
          ref={meterRef}
          className="meter-track mt-2"
          role="meter"
          aria-label="Nivel de salida"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
        >
          <div ref={fillRef} className="meter-fill" />
          <div ref={peakRef} className="meter-peak" />
        </div>
      </div>
    </div>
  );
}

export function Cobre() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [armed, setArmed] = useState(false);
  const [active, setActive] = useState<Set<number>>(() => new Set());
  const settingsRef = useRef(settings);
  const octaveRef = useRef(settings.octave);
  const engineRef = useRef<SynthEngine | null>(null);
  const sources = useRef<Map<string, number>>(new Map());
  settingsRef.current = settings;
  octaveRef.current = settings.octave;

  const getEngine = useCallback(() => {
    if (!engineRef.current) engineRef.current = new SynthEngine(settingsRef.current);
    return engineRef.current;
  }, []);

  const publish = useCallback(() => {
    setActive(new Set(sources.current.values()));
  }, []);

  const up = useCallback(
    (source: string) => {
      const prev = sources.current.get(source);
      if (prev === undefined) return;
      sources.current.delete(source);
      if (![...sources.current.values()].includes(prev)) getEngine().noteOff(prev);
      publish();
    },
    [getEngine, publish],
  );

  const down = useCallback(
    (source: string, midi: number) => {
      const prev = sources.current.get(source);
      if (prev === midi) return;
      if (prev !== undefined) {
        sources.current.delete(source);
        if (![...sources.current.values()].includes(prev)) getEngine().noteOff(prev);
      }
      sources.current.set(source, midi);
      publish();
      const held = [...sources.current.values()].filter((note) => note === midi).length;
      if (held !== 1) return;
      const engine = getEngine();
      if (engine.running) {
        engine.noteOn(midi);
        setArmed(true);
        return;
      }
      void engine.start().then((ok) => {
        setArmed(ok);
        if (!ok) return;
        if ([...sources.current.values()].includes(midi)) engine.noteOn(midi);
      });
    },
    [getEngine, publish],
  );

  const releaseAll = useCallback(() => {
    sources.current.clear();
    getEngine().allOff();
    publish();
  }, [getEngine, publish]);

  const nudgeOctave = useCallback((dir: number) => {
    setSettings((current) => ({
      ...current,
      octave: clamp(current.octave + dir, OCTAVE_MIN, OCTAVE_MAX),
    }));
  }, []);

  useEffect(() => {
    setSettings(loadSettings());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    saveSettings(settings);
    engineRef.current?.update(settings);
  }, [ready, settings]);

  useEffect(() => {
    return () => engineRef.current?.dispose();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isControlTarget(event.target)) return;
      if (event.code === "Space") {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("button, a, [role='button']")) return;
        event.preventDefault();
        return;
      }
      if (event.code === "KeyZ" || event.code === "KeyX") {
        event.preventDefault();
        nudgeOctave(event.code === "KeyZ" ? -1 : 1);
        return;
      }
      const semi = CODE_TO_SEMI[event.code];
      if (semi === undefined) return;
      event.preventDefault();
      down(`k:${event.code}`, midiFromOctave(octaveRef.current, semi));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (CODE_TO_SEMI[event.code] === undefined) return;
      up(`k:${event.code}`);
    };
    const onBlur = () => {
      for (const source of [...sources.current.keys()]) {
        if (source.startsWith("k:")) up(source);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [down, nudgeOctave, up]);

  const keys = useMemo(() => buildKeys(settings.octave), [settings.octave]);
  const slot = 100 / keys.whiteCount;
  const blackWidth = slot * 0.62;
  const rootName = noteLabel(midiFromOctave(settings.octave, 0));

  const togglePower = () => {
    const engine = getEngine();
    if (engine.running) {
      releaseAll();
      void engine.stop().then(() => setArmed(false));
      return;
    }
    void engine.start().then((ok) => setArmed(ok));
  };

  return (
    <main className="stage mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-5 px-4 pt-5 pb-8 md:gap-6 md:px-8 md:pt-8 md:pb-24">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-widest text-copper uppercase">Estudio</p>
          <h1 className="mt-1 font-display text-5xl leading-none font-medium text-paper">Cobre</h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
            Sintetizador polifónico. Tócalo en pantalla o con el teclado del ordenador. El sonido espera a tu primer gesto.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted" role="status">
            <span className={armed ? "status-dot is-on" : "status-dot"} aria-hidden="true" />
            {armed ? "Audio activo" : "En silencio"}
          </p>
          <button
            type="button"
            data-skip-keys
            data-power
            className="power-btn"
            data-on={armed ? "true" : "false"}
            onClick={togglePower}
          >
            <Power className="size-4" aria-hidden="true" />
            {armed ? "Apagar" : "Encender"}
          </button>
        </div>
      </header>

      <div className="stage-controls">
      <section className="chassis" aria-label="Controles">
        <span className="screw screw-tl" aria-hidden="true" />
        <span className="screw screw-tr" aria-hidden="true" />
        <span className="screw screw-bl" aria-hidden="true" />
        <span className="screw screw-br" aria-hidden="true" />

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-xs font-medium tracking-widest text-muted uppercase">Forma de onda</h2>
              <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Forma de onda">
                {WAVEFORMS.map((wave) => {
                  const on = settings.waveform === wave.id;
                  return (
                    <button
                      key={wave.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      data-skip-keys
                      className={on ? "wave-btn is-on" : "wave-btn"}
                      onClick={() => setSettings((current) => ({ ...current, waveform: wave.id }))}
                    >
                      <WaveIcon id={wave.id} />
                      {wave.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <h2 className="text-xs font-medium tracking-widest text-muted uppercase">Octava</h2>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  data-skip-keys
                  className="icon-btn"
                  aria-label="Bajar octava"
                  disabled={settings.octave <= OCTAVE_MIN}
                  onClick={() => nudgeOctave(-1)}
                >
                  <Minus className="size-4" aria-hidden="true" />
                </button>
                <p className="octave-readout" aria-live="polite">
                  {rootName}
                </p>
                <button
                  type="button"
                  data-skip-keys
                  className="icon-btn"
                  aria-label="Subir octava"
                  disabled={settings.octave >= OCTAVE_MAX}
                  onClick={() => nudgeOctave(1)}
                >
                  <Plus className="size-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          <div>
            <h2 className="text-xs font-medium tracking-widest text-muted uppercase">Filtro y envolvente</h2>
            <div className="mt-3 grid grid-cols-4 gap-x-2 gap-y-4 sm:grid-cols-7">
              <Knob
                label="Corte"
                value={expUnmap(settings.cutoff, CUTOFF.min, CUTOFF.max)}
                display={formatHz(settings.cutoff)}
                onChange={(value) =>
                  setSettings((current) => ({ ...current, cutoff: expMap(value, CUTOFF.min, CUTOFF.max) }))
                }
              />
              <Knob
                label="Resonancia"
                value={(settings.resonance - RESONANCE.min) / (RESONANCE.max - RESONANCE.min)}
                display={settings.resonance.toFixed(1)}
                onChange={(value) =>
                  setSettings((current) => ({
                    ...current,
                    resonance: RESONANCE.min + value * (RESONANCE.max - RESONANCE.min),
                  }))
                }
              />
              <Knob
                label="Ataque"
                value={expUnmap(settings.attack, ATTACK.min, ATTACK.max)}
                display={formatSecs(settings.attack)}
                onChange={(value) =>
                  setSettings((current) => ({ ...current, attack: expMap(value, ATTACK.min, ATTACK.max) }))
                }
              />
              <Knob
                label="Caída"
                value={expUnmap(settings.decay, DECAY.min, DECAY.max)}
                display={formatSecs(settings.decay)}
                onChange={(value) =>
                  setSettings((current) => ({ ...current, decay: expMap(value, DECAY.min, DECAY.max) }))
                }
              />
              <Knob
                label="Sostén"
                value={settings.sustain}
                display={`${Math.round(settings.sustain * 100)}%`}
                onChange={(value) => setSettings((current) => ({ ...current, sustain: value }))}
              />
              <Knob
                label="Suelta"
                value={expUnmap(settings.release, RELEASE.min, RELEASE.max)}
                display={formatSecs(settings.release)}
                onChange={(value) =>
                  setSettings((current) => ({ ...current, release: expMap(value, RELEASE.min, RELEASE.max) }))
                }
              />
              <Knob
                label="Volumen"
                value={settings.volume}
                display={`${Math.round(settings.volume * 100)}%`}
                onChange={(value) => setSettings((current) => ({ ...current, volume: value }))}
              />
            </div>
          </div>

          <Scope engineRef={engineRef} armed={armed} voices={active.size} />
        </div>
      </section>
      </div>

      <section className="keyboard-dock" aria-label="Teclado">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium tracking-widest text-muted uppercase">Teclado</h2>
          <button type="button" data-skip-keys className="text-btn" onClick={releaseAll}>
            Silenciar notas
          </button>
        </div>
        <div className="piano-scroll">
          <p className="piano-grab">Desliza para ver el resto</p>
          <div
            className="piano"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const midi = midiAt(event.clientX, event.clientY);
              if (midi == null) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              down(`p:${event.pointerId}`, midi);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const midi = midiAt(event.clientX, event.clientY);
              const source = `p:${event.pointerId}`;
              if (midi == null) up(source);
              else down(source, midi);
            }}
            onPointerUp={(event) => up(`p:${event.pointerId}`)}
            onPointerCancel={(event) => up(`p:${event.pointerId}`)}
            onLostPointerCapture={(event) => up(`p:${event.pointerId}`)}
            onContextMenu={(event) => event.preventDefault()}
          >
            {keys.whites.map((key) => {
              const label = SEMI_LABEL[key.semi];
              const name = pitchName(key.midi);
              return (
                <button
                  key={key.midi}
                  type="button"
                  className="white-key"
                  data-midi={key.midi}
                  data-active={active.has(key.midi) ? "true" : "false"}
                  aria-label={label ? `${name}, tecla ${label}` : name}
                  aria-pressed={active.has(key.midi)}
                >
                  {label ? (
                    <>
                      <span className="key-hint">{label}</span>
                      <span className="key-note">{name.split(" ")[0]}</span>
                    </>
                  ) : (
                    <span className="key-hint">{name.replace(" ", "")}</span>
                  )}
                </button>
              );
            })}
            {keys.blacks.map((key) => {
              const label = SEMI_LABEL[key.semi];
              const name = pitchName(key.midi);
              return (
                <button
                  key={key.midi}
                  type="button"
                  className="black-key"
                  data-midi={key.midi}
                  data-active={active.has(key.midi) ? "true" : "false"}
                  aria-label={label ? `${name}, tecla ${label}` : name}
                  aria-pressed={active.has(key.midi)}
                  style={{ left: `${key.slot * slot - blackWidth / 2}%`, width: `${blackWidth}%` }}
                >
                  {label ? <span className="key-hint">{label}</span> : null}
                </button>
              );
            })}
          </div>
        </div>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
          Blancas con A S D F G H J K L y las dos teclas a su derecha. Negras con W E T Y U O P. Z baja la octava y X la
          sube. Mantén Mayús al girar una perilla para afinar fino.
        </p>
        <p className="mt-2 text-xs text-muted">Hecho con IA.</p>
      </section>
    </main>
  );
}
