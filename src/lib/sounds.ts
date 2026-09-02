/* ============================================================
   MOTOR DE RETROALIMENTACIÓN AUDITIVA
   ------------------------------------------------------------
   Cambiamos el diseño: los beeps ahora se generan como WAV
   en memoria y se reproducen por un pool de <audio> elements
   con `setSinkId` aplicado.

   ¿Por qué? En Chrome para Android, `AudioContext.setSinkId`
   (sinkId en el constructor o via setter) **no funciona** de
   forma consistente. El audio del AudioContext termina saliendo
   por el altavoz del teléfono aunque le pidas el dispositivo
   BT. En cambio, `HTMLMediaElement.setSinkId` (en <audio>) sí
   está soportado y es la forma oficial de rutear la salida en
   la web móvil.

   Entonces:
     · AudioContext → solo para el analizador del waveform
       (createMediaStreamSource + AnalyserNode). No emite audio.
     · SFX → <audio> elements con setSinkId, alimentados con
       WAVs generados on-the-fly.
     · Warm-up → otro <audio> con un WAV de silencio, dispara
       justo antes de speechSynthesis.speak() para "enganchar"
       el ruteo BT del sistema.

   Cada estado de la app tiene un sonido distintivo:
     · recStart  → beep corto y agudo (800 Hz / 100 ms): inicia grabación
     · recTick   → el mismo beep, repetido cada 2 s mientras graba activamente
     · recPause  → beep grave (400 Hz / 150 ms): grabación en pausa
     · send      → dos beeps ascendentes rápidos (600 → 900 Hz): audio enviado
     · think     → beep suave y bajo cada segundo: la IA está procesando
     · ready     → arpegio alegre ascendente: respuesta lista, empieza a hablar
     · error     → doble tono descendente: algo falló
   ============================================================ */

/** Volumen general de los feedbacks. Ajústalo aquí (0.0 – 1.0). */
export const SOUND_VOLUME = 0.3;

let ctx: AudioContext | null = null;
let muted = false;

/** `sinkId` actualmente aplicado a los <audio> elements de sfx. */
let sfxSinkId: string | null = null;
/** Pool de <audio> para reproducir sfx en paralelo sin cortarse. */
const sfxPool: HTMLAudioElement[] = [];
let sfxPoolIdx = 0;

const SFX_POOL_SIZE = 6;

/* ---------------- AudioContext (solo para el analizador) ---------------- */

export function setSfxMuted(value: boolean) {
  muted = value;
}

/** Devuelve (y crea perezoso) el AudioContext, solo para el analizador
 *  del waveform. NO emite audio por este contexto. */
export function ensureAudio(): AudioContext {
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
  }
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  return ctx;
}

/** Compat: ya no aplicamos sinkId al AudioContext (no funciona en
 *  Chrome Android). Lo dejamos como no-op para no romper importadores. */
export function setOutputSinkId(_id: string | null): boolean {
  return false;
}

/* ---------------- Generación de WAV en memoria ---------------- */

interface ToneSpec {
  freq: number;
  dur: number; // segundos
  type: OscillatorType;
  /** Si se especifica, la frecuencia hace glissando hacia este valor. */
  slideTo?: number;
  /** Ganancia relativa (0–1, multiplicada por SOUND_VOLUME). */
  gain?: number;
  /** Si es > 0, retrasa el inicio del tono en segundos. */
  at?: number;
}

/** Genera un WAV PCM 16-bit mono con sampleRate dado. */
function wavFromTones(tones: ToneSpec[], sampleRate = 22050): Blob {
  let totalDur = 0;
  for (const t of tones) totalDur = Math.max(totalDur, t.at ?? 0 + t.dur);
  // Sumamos un pequeño silencio final para que la cola no se corte.
  const numSamples = Math.ceil((totalDur + 0.05) * sampleRate);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  // RIFF header
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  // Generamos sample por sample, mezclando todos los tonos activos.
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let mix = 0;
    for (const T of tones) {
      const start = T.at ?? 0;
      const end = start + T.dur;
      if (t < start || t > end) continue;
      const localT = t - start;
      const freq = T.slideTo ? T.freq + (T.slideTo - T.freq) * (localT / T.dur) : T.freq;
      const phase = 2 * Math.PI * freq * localT;
      let sample: number;
      switch (T.type) {
        case "sine":
          sample = Math.sin(phase);
          break;
        case "square":
          sample = Math.sign(Math.sin(phase));
          break;
        case "triangle":
          sample = (2 / Math.PI) * Math.asin(Math.sin(phase));
          break;
        case "sawtooth":
          sample = 2 * (localT * freq - Math.floor(0.5 + localT * freq));
          break;
        default:
          sample = Math.sin(phase);
      }
      // Envolvente: ataque 12 ms, decay al final
      const attack = 0.012;
      const release = 0.05;
      let env: number;
      if (localT < attack) env = localT / attack;
      else if (localT > T.dur - release) env = Math.max(0, (T.dur - localT) / release);
      else env = 1;
      const amp = env * SOUND_VOLUME * (T.gain ?? 1) * 0.35;
      mix += sample * amp;
    }
    const clipped = Math.max(-1, Math.min(1, mix));
    view.setInt16(44 + i * 2, Math.round(clipped * 0x7fff), true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Genera un WAV de silencio (para warm-up de salida). */
function silenceWav(durationSec: number, sampleRate = 8000): Blob {
  const numSamples = Math.ceil(durationSec * sampleRate);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  // samples quedan a 0 → silencio
  return new Blob([buffer], { type: "audio/wav" });
}

/* ---------------- Pool de <audio> para sfx ---------------- */

function getPoolAudio(): HTMLAudioElement {
  if (sfxPool.length === 0) {
    for (let i = 0; i < SFX_POOL_SIZE; i++) {
      const a = new Audio();
      a.preload = "auto";
      sfxPool.push(a);
    }
  }
  const a = sfxPool[sfxPoolIdx % sfxPool.length];
  sfxPoolIdx = (sfxPoolIdx + 1) % sfxPool.length;
  return a;
}

function applySink(a: HTMLAudioElement) {
  const sa = a as unknown as { setSinkId?: (id: string) => Promise<void> };
  if (typeof sa.setSinkId === "function") {
    try {
      void sa.setSinkId(sfxSinkId ?? "default");
    } catch {
      /* el dispositivo se desconectó o no es aceptable */
    }
  }
}

function playBlob(blob: Blob): void {
  if (muted) return;
  const a = getPoolAudio();
  applySink(a);
  try {
    a.src = URL.createObjectURL(blob);
    void a.play().catch(() => {
      /* autoplay bloqueado o sink no disponible: el siguiente gesto del
         usuario lo destraba. No es grave. */
    });
  } catch {
    /* no-op */
  }
}

/* ---------------- SFX ---------------- */

export const sfx = {
  recStart() {
    playBlob(wavFromTones([{ freq: 800, dur: 0.1, type: "sine" }]));
  },
  recTick() {
    playBlob(wavFromTones([{ freq: 800, dur: 0.08, type: "sine", gain: 0.7 }]));
  },
  recPause() {
    playBlob(wavFromTones([{ freq: 400, dur: 0.15, type: "sine" }]));
  },
  send() {
    playBlob(
      wavFromTones([
        { freq: 600, dur: 0.09, type: "sine" },
        { freq: 900, dur: 0.12, type: "sine", at: 0.11 },
      ])
    );
  },
  think() {
    playBlob(wavFromTones([{ freq: 320, dur: 0.18, type: "triangle", gain: 0.55 }]));
  },
  ready() {
    playBlob(
      wavFromTones([
        { freq: 523.25, dur: 0.1, type: "sine" },
        { freq: 659.25, dur: 0.1, type: "sine", at: 0.09 },
        { freq: 783.99, dur: 0.18, type: "sine", at: 0.18 },
      ])
    );
  },
  error() {
    playBlob(
      wavFromTones([
        { freq: 240, dur: 0.12, type: "square", gain: 0.3 },
        { freq: 170, dur: 0.16, type: "square", gain: 0.3, at: 0.13 },
      ])
    );
  },
};

/* ============================================================
   WARM-UP DE SALIDA (para speechSynthesis)
   ------------------------------------------------------------
   En Android (Chrome / Samsung Internet) `speechSynthesis` a veces
   arranca por el altavoz del teléfono aunque haya un dispositivo
   Bluetooth conectado. La causa típica: la página no estaba
   reproduciendo audio por una ruta "ruteable" cuando se dispara
   el TTS, así que el sistema elige el destino por defecto.

   Truco: justo antes de `speak()`, reproducimos ~100 ms de silencio
   por un `<audio>` element con `setSinkId` aplicado al dispositivo
   de salida elegido. Esto "engancha" el destino BT, y la utterance
   siguiente sale por la misma ruta.
   ============================================================ */

let warmupAudio: HTMLAudioElement | null = null;
let warmupSinkId: string | null = null;

function getWarmupAudio(): HTMLAudioElement {
  if (!warmupAudio) {
    warmupAudio = new Audio();
    warmupAudio.preload = "auto";
    // 250 ms de silencio: le da tiempo a Android de "asentar" el
    // nuevo sinkId antes de que llegue el utterance. Si es muy corto
    // (probamos con 100 ms) el primer fragmento del TTS se pierde.
    warmupAudio.src = URL.createObjectURL(silenceWav(0.25));
  }
  return warmupAudio;
}

export function setWarmupSinkId(id: string | null) {
  warmupSinkId = id;
  const a = getWarmupAudio();
  const sa = a as unknown as { setSinkId?: (id: string) => Promise<void> };
  if (typeof sa.setSinkId === "function") {
    try {
      void sa.setSinkId(id ?? "default");
    } catch {
      /* dispositivo no disponible — el próximo play usará el default */
    }
  }
}

export function warmupOutput(): Promise<void> {
  const a = getWarmupAudio();
  const sa = a as unknown as { setSinkId?: (id: string) => Promise<void> };
  if (typeof sa.setSinkId === "function" && warmupSinkId !== null) {
    try {
      void sa.setSinkId(warmupSinkId);
    } catch {
      /* no-op */
    }
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      a.currentTime = 0;
      const p = a.play();
      if (p && typeof p.then === "function") {
        p.then(finish).catch(finish);
      } else {
        setTimeout(finish, 30);
      }
    } catch {
      finish();
    }
    setTimeout(finish, 320);
  });
}
