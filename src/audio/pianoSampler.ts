import type { Note } from '../core/midi/types';

export interface Voice { stop(when: number): void }

// Una muestra cada 3 semitonos: A0, C1, D#1, F#1, A1 ... C8  (30 archivos)
const NAMES: Record<number, string> = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };
const sampleName = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

export const MASTER_BASE = 0.8;

// ── Nivelado de las muestras ──────────────────────────────────────────────────────────────────────
// Las grabaciones de Salamander no están niveladas entre sí: algunas muestras salen varios dB por debajo de
// sus vecinas y al tocar una escala el volumen da "escalones" cada 3 notas. Se corrige SOLO esa irregularidad:
// se mide cada muestra, se calcula la tendencia suave de las vecinas y se acerca cada una a ella. La
// inclinación natural (graves más fuertes que agudos, como en un piano real) se conserva.
const LEVEL_WINDOW = 0.5;   // s analizados desde el inicio de cada muestra
const LEVEL_SPAN = 2;       // vecinos a cada lado para la tendencia (mediana de 5 muestras)
const LEVEL_MAX_DB = 5;     // corrección máxima por muestra (dB)
/** Inclinación opcional (dB entre el extremo grave y el agudo): >0 baja los graves y sube los agudos. 0 = sin cambio. */
export const TILT_DB = 0;

export interface SampleLevel { peak: number; rms: number } // dB

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** Corrección en dB de cada muestra (misma longitud que `midis`, que debe venir ordenado). */
export function sampleGainsDb(midis: number[], levels: SampleLevel[], tiltDb = TILT_DB): number[] {
  // Desviación de cada muestra respecto a la mediana de sus vecinas, para el pico y para el nivel medio; se promedian
  const dev = (vals: number[]) => vals.map((v, i) => median(vals.slice(Math.max(0, i - LEVEL_SPAN), i + LEVEL_SPAN + 1)) - v);
  const dp = dev(levels.map((l) => l.peak));
  const dr = dev(levels.map((l) => l.rms));
  const mid = (midis[0] + midis[midis.length - 1]) / 2;
  const half = Math.max(1, (midis[midis.length - 1] - midis[0]) / 2);
  return midis.map((m, i) => {
    const fix = Math.max(-LEVEL_MAX_DB, Math.min(LEVEL_MAX_DB, (dp[i] + dr[i]) / 2));
    return fix + ((m - mid) / half) * (tiltDb / 2);
  });
}

function measureLevel(buf: AudioBuffer): SampleLevel {
  const n = Math.min(buf.length, Math.floor(buf.sampleRate * LEVEL_WINDOW));
  let peak = 0, sum = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; }
  }
  return { peak: 20 * Math.log10(Math.max(peak, 1e-9)), rms: 10 * Math.log10(Math.max(sum / (n * buf.numberOfChannels), 1e-12)) };
}

/** Salida común: volumen + compresor para que los acordes no saturen. Igual en vivo y offline. */
export function createMasterBus(ctx: BaseAudioContext, volume = 1): GainNode {
  const gain = ctx.createGain();
  gain.gain.value = MASTER_BASE * volume;
  const comp = ctx.createDynamicsCompressor();
  gain.connect(comp);
  comp.connect(ctx.destination);
  return gain;
}

export class PianoSampler {
  private buffers = new Map<number, AudioBuffer>();
  private sampleMidis: number[] = [];
  private nearestCache = new Map<number, number>();
  private gains = new Map<number, number>(); // corrección de nivel (lineal) por muestra

  get hasSamples() { return this.buffers.size > 0; }

  /** Devuelve true si cargó al menos una muestra. Si no, se usa un sonido de prueba. */
  async load(ctx: BaseAudioContext): Promise<boolean> {
    const base = `${import.meta.env.BASE_URL}samples/piano/`;
    const jobs: Promise<void>[] = [];
    for (let m = 21; m <= 108; m += 3) {
      jobs.push((async () => {
        const res = await fetch(`${base}${sampleName(m)}.ogg`);
        if (!res.ok) throw new Error(`No se pudo cargar ${sampleName(m)}`);
        this.buffers.set(m, await ctx.decodeAudioData(await res.arrayBuffer()));
      })());
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length === jobs.length)
      console.warn('[piano] No se cargó ninguna muestra. ¿Existe public/samples/piano/*.ogg? (node scripts/copy-samples.mjs)', failed[0].reason);
    else if (failed.length > 0)
      console.warn(`[piano] ${failed.length}/${jobs.length} muestras fallaron`, failed[0].reason);
    this.sampleMidis = [...this.buffers.keys()].sort((a, b) => a - b);
    this.nearestCache.clear();
    this.gains.clear();
    if (this.sampleMidis.length >= 3) {
      const db = sampleGainsDb(this.sampleMidis, this.sampleMidis.map((m) => measureLevel(this.buffers.get(m)!)));
      this.sampleMidis.forEach((m, i) => this.gains.set(m, 10 ** (db[i] / 20)));
      console.debug('[piano] corrección de nivel por muestra (dB)', Object.fromEntries(this.sampleMidis.map((m, i) => [sampleName(m), +db[i].toFixed(1)])));
    }
    if (this.buffers.size > 0 && this.buffers.size < 30)
      console.warn(`Solo se cargaron ${this.buffers.size}/30 muestras de piano.`);
    return this.buffers.size > 0;
  }

  private nearest(midi: number): number {
    let n = this.nearestCache.get(midi);
    if (n === undefined) {
      n = this.sampleMidis.reduce((best, s) => (Math.abs(s - midi) < Math.abs(best - midi) ? s : best));
      this.nearestCache.set(midi, n);
    }
    return n;
  }

  /** Programa UNA nota en el instante `when` (tiempo del AudioContext). Sirve en vivo y offline. */
  playNote(ctx: BaseAudioContext, dest: AudioNode, note: Note, when: number, onEnd?: () => void): Voice {
    const end = when + note.soundDuration;
    let level = 0.9 * Math.pow(note.velocity, 1.5); // velocity → volumen (curva no lineal)
    const gain = ctx.createGain();
    gain.connect(dest);

    let src: AudioScheduledSourceNode;
    if (this.buffers.size > 0) {
      const s = this.nearest(note.midi);
      const bs = ctx.createBufferSource();
      bs.buffer = this.buffers.get(s)!;
      bs.playbackRate.value = 2 ** ((note.midi - s) / 12); // afina la muestra más cercana
      level *= this.gains.get(s) ?? 1; // nivelado entre muestras
      src = bs;
      gain.gain.setValueAtTime(level, when);
    } else {
      // Sonido de prueba (sin muestras): triángulo con decaimiento
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
      src = osc;
      gain.gain.setValueAtTime(level * 0.5, when);
      gain.gain.setTargetAtTime(level * 0.08, when, 0.6);
    }
    src.connect(gain);

    gain.gain.setTargetAtTime(0, end, 0.12); // release al terminar la nota (incluye pedal)
    src.start(when);
    src.stop(end + 1);
    src.onended = () => { gain.disconnect(); onEnd?.(); };

    return {
      stop(t: number) { // corte rápido sin "clic" (pausa / seek)
        gain.gain.cancelAndHoldAtTime(t);
        gain.gain.setTargetAtTime(0, t, 0.015);
        try { src.stop(t + 0.1); } catch { /* ya detenida */ }
      },
    };
  }
}

/** Una sola instancia: el preview y el export comparten las mismas muestras ya decodificadas. */
export const pianoSampler = new PianoSampler();
