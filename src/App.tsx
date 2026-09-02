/* ============================================================
   ASISTENTE GEM · Biología del Comportamiento
   ------------------------------------------------------------
   Consola de estudio 100% frontend:

   · Botón 1 (Grabar/Pausar)  → MediaRecorder con pause()/resume(),
     acumula TODO en un único Blob sin importar las pausas.
   · Botón 2 (Enviar)         → stop(), Base64 y POST a Gemini
     con `inlineData`. Solo se habilita si hay audio grabado.
   · Botón 3 (Play/Pausa voz) → speechSynthesis.pause()/resume().

   Los 3 botones viven en una barra fija (sticky): mismo lugar,
   mismo tamaño, siempre. Solo cambian sus etiquetas/estados.

   CICLO CONTINUO (punto 5): al presionar Grabar tras una respuesta,
   se ejecuta un reset limpio:
     1. speechSynthesis.cancel()
     2. audioChunks = []
     3. nueva instancia de MediaRecorder (clip 100% independiente)
     4. estado visual → "Grabando…" sin recargar la página
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Waveform from "./components/Waveform";
import type { WaveMode } from "./components/Waveform";
import {
  MicIcon,
  PauseIcon,
  PlayIcon,
  SendIcon,
  SpeakerOnIcon,
  SpeakerOffIcon,
  KeyIcon,
  HistoryIcon,
  TrashIcon,
  AlertIcon,
  EyeIcon,
  EyeOffIcon,
  GitBranchIcon,
  ZapIcon,
  UploadIcon,
  GlobeIcon,
} from "./components/icons";
import { ensureAudio, sfx, setSfxMuted, SOUND_VOLUME, warmupOutput, setWarmupSinkId } from "./lib/sounds";
import { cleanForTTS } from "./lib/tts";
import {
  askGemini,
  blobToBase64,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GeminiError,
  SYSTEM_PROMPT,
  pickMimeType,
} from "./lib/gemini";
import {
  type AudioDevice,
  getSavedInputId,
  getSavedOutputId,
  onDevicesChange,
  saveInputId,
  saveOutputId,
  startDeviceWatcher,
  supportsAudioContextSinkId,
  supportsOutputSelection,
} from "./lib/audioDevices";

/* ---------------- Tipos y utilidades ---------------- */

type Phase =
  | "idle"
  | "starting" // adquiriendo micrófono (transitorio)
  | "recording"
  | "paused"
  | "sending"
  | "processing"
  | "speaking"
  | "voicePaused";

interface HistoryItem {
  id: number;
  time: string;
  text: string;
}

/** Lee/escribe localStorage sin romper si el navegador lo bloquea. */
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* sin persistencia */
    }
  },
};

function formatTime(ms: number): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const d = Math.floor((total % 1000) / 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${d}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/** Elige la mejor voz en español disponible. */
function pickSpanishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  return (
    voices.find((v) => /^es/i.test(v.lang) && /google/i.test(v.name)) ??
    voices.find((v) => /^es[-_]/i.test(v.lang)) ??
    voices.find((v) => /espa/i.test(v.name)) ??
    null
  );
}

/* ---------------- Piezas de UI ---------------- */

/** Aparece suavemente al entrar en el viewport. */
function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${visible ? "is-visible" : ""}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/** Barras animadas visibles mientras la voz está hablando. */
function Equalizer() {
  return (
    <span className="inline-flex items-end gap-[3px]" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="eq-bar" style={{ animationDelay: `${i * 0.13}s` }} />
      ))}
    </span>
  );
}

type Accent = "coral" | "cyan" | "mint" | "amber";

const ACCENT_TEXT: Record<Accent, string> = {
  coral: "text-[#ff6b5e]",
  cyan: "text-[#4cc9d4]",
  mint: "text-[#3ddc97]",
  amber: "text-[#ffc24b]",
};

/** Punto de estado con color por fase. */
function StatusDot({ phase }: { phase: Phase }) {
  const map: Record<Phase, { cls: string; color: string }> = {
    idle: { cls: "", color: "bg-[#8fb0ac]" },
    starting: { cls: "dot-throb", color: "bg-[#4cc9d4]" },
    recording: { cls: "dot-blink", color: "bg-[#ff6b5e]" },
    paused: { cls: "", color: "bg-[#ffc24b]" },
    sending: { cls: "dot-throb", color: "bg-[#4cc9d4]" },
    processing: { cls: "dot-throb", color: "bg-[#ffc24b]" },
    speaking: { cls: "dot-blink", color: "bg-[#3ddc97]" },
    voicePaused: { cls: "", color: "bg-[#3ddc97]" },
  };
  const { cls, color } = map[phase];
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color} ${cls}`} />;
}

interface ControlButtonProps {
  accent: Accent;
  icon: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean; // grabación activa → anillo pulsante
}

/**
 * Uno de los 3 botones de la fila fija. Tamaño y posición constantes;
 * solo cambian etiqueta, ícono y estado habilitado.
 */
function ControlButton({ accent, icon, label, hint, onClick, disabled, active }: ControlButtonProps) {
  const hoverBorder: Record<Accent, string> = {
    coral: "hover:border-[#ff6b5e]/70 hover:shadow-[0_10px_34px_-14px_rgba(255,107,94,0.55)]",
    cyan: "hover:border-[#4cc9d4]/70 hover:shadow-[0_10px_34px_-14px_rgba(76,201,212,0.5)]",
    mint: "hover:border-[#3ddc97]/70 hover:shadow-[0_10px_34px_-14px_rgba(61,220,151,0.5)]",
    amber: "hover:border-[#ffc24b]/70 hover:shadow-[0_10px_34px_-14px_rgba(255,194,75,0.5)]",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`ctrl-btn relative flex h-24 flex-col items-center justify-center gap-1.5 rounded-xl border bg-[#0f2226] px-2 outline-none sm:h-28 ${
        active ? "border-[#ff6b5e]/80" : "border-[#1e3b41]"
      } ${hoverBorder[accent]} focus-visible:ring-2 focus-visible:ring-[#4cc9d4]/60`}
    >
      {active && <span className="rec-pulse pointer-events-none absolute inset-0 rounded-xl" aria-hidden />}
      <span className={ACCENT_TEXT[accent]}>{icon}</span>
      <span className="text-sm font-semibold tracking-wide text-[#e9f4f1]">{label}</span>
      <span className="font-mono-gem text-[10px] uppercase tracking-[0.14em] text-[#8fb0ac]">{hint}</span>
    </button>
  );
}

/* ---------------- Aplicación principal ---------------- */

export default function App() {
  /* ----- Estado visible ----- */
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("En espera — presiona Grabar para comenzar");
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  /** Detalle técnico del último error (para el <details> colapsable). */
  const [errorDetail, setErrorDetail] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [clipBytes, setClipBytes] = useState(0);
  const [muted, setMutedUi] = useState(() => store.get("gem-muted") === "1");
  const [savedKey, setSavedKey] = useState(() => store.get("gem-api-key") ?? "");
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keySavedFlash, setKeySavedFlash] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [selectedInputId, setSelectedInputId] = useState<string | null>(() => getSavedInputId());
  const [selectedOutputId, setSelectedOutputId] = useState<string | null>(() => getSavedOutputId());
  /** Nombre del dispositivo de mic que el stream está usando AHORA MISMO
   *  (lo leemos de `track.getSettings().label` tras cada getUserMedia). */
  const [activeMicLabel, setActiveMicLabel] = useState<string>("");
  /** Mensaje diagnóstico adicional (p.ej. si el deviceId exacto no se pudo aplicar). */
  const [micDiagnostic, setMicDiagnostic] = useState<string>("");

  /* ----- Referencias internas (evitan closures obsoletos) ----- */
  const phaseRef = useRef<Phase>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]); // ← el arreglo que acumula TODO el clip
  const mimeRef = useRef("audio/webm");
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sendRequestedRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null); // beep cada 2 s
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null); // cronómetro
  const thinkRef = useRef<ReturnType<typeof setInterval> | null>(null); // beep "pensando"
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null); // legacy: ya no se usa, conservado por compat
  const lastTickRef = useRef(0);
  const elapsedRef = useRef(0);
  const responseRef = useRef("");
  const userPausedRef = useRef(false);
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null);
  const keyRef = useRef(savedKey);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  keyRef.current = savedKey;
  voicesRef.current = voices;

  /** Cambia la fase en el ref y en el estado a la vez. */
  const goPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const clearAllIntervals = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    if (thinkRef.current) clearInterval(thinkRef.current);
    tickRef.current = timerRef.current = thinkRef.current = null;
  }, []);

  /* ----- Carga de voces (SpeechSynthesis es asíncrono) ----- */
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  /* ----- Watcher de dispositivos de audio (entrada y salida) -----
   * Mantiene la lista viva ante `devicechange` (BT se conecta/desconecta
   * en caliente) y la refresca después del primer getUserMedia, porque
   * hasta entonces Chrome entrega labels vacíos. */
  useEffect(() => {
    let cancelled = false;
    void startDeviceWatcher().then((d) => {
      if (cancelled) return;
      setInputDevices(d.inputs);
      setOutputDevices(d.outputs);
    });
    const off = onDevicesChange((d) => {
      if (cancelled) return;
      setInputDevices(d.inputs);
      setOutputDevices(d.outputs);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  /* ----- Aplica el dispositivo de salida elegido al motor de audio -----
   * Los sfx se reproducen por <audio> elements (con setSinkId), no por
   * el AudioContext — en Chrome Android el setSinkId del AudioContext
   * no funciona de forma consistente. Por eso acá solo actualizamos
   * el sinkId del elemento de warm-up (para que el TTS también
   * "vea" la salida BT). */
  useEffect(() => {
    setWarmupSinkId(selectedOutputId);
  }, [selectedOutputId]);

  /* ----- Auto-limpia la selección si el dispositivo guardado ya no
   * existe (típico cuando se desconectan los auriculares BT). */
  useEffect(() => {
    if (selectedInputId && inputDevices.length > 0 && !inputDevices.some((d) => d.deviceId === selectedInputId)) {
      setSelectedInputId(null);
      saveInputId(null);
    }
  }, [inputDevices, selectedInputId]);
  useEffect(() => {
    if (selectedOutputId && outputDevices.length > 0 && !outputDevices.some((d) => d.deviceId === selectedOutputId)) {
      setSelectedOutputId(null);
      saveOutputId(null);
    }
  }, [outputDevices, selectedOutputId]);

  /* ----- Helper: arma las constraints de getUserMedia con la
   * selección de entrada del usuario. Si no hay selección, pide el
   * dispositivo por defecto del sistema. */
  const buildAudioConstraints = useCallback((): MediaStreamConstraints => {
    if (selectedInputId) {
      return {
        audio: {
          deviceId: { exact: selectedInputId },
          // Desactivamos el procesamiento agresivo del navegador que a
          // veces mete eco y cancela el audio del receptor USB/BT.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      };
    }
    return { audio: true };
  }, [selectedInputId]);

  /* ----- Silencio persistente ----- */
  useEffect(() => {
    setSfxMuted(muted);
  }, [muted]);

  /* ----- Limpieza total al desmontar ----- */
  useEffect(() => {
    return () => {
      clearAllIntervals();
      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [clearAllIntervals]);

  /* ============ CRONÓMETRO (solo corre mientras graba activo) ============ */
  const startChrono = useCallback(() => {
    lastTickRef.current = performance.now();
    timerRef.current = setInterval(() => {
      const now = performance.now();
      elapsedRef.current += now - lastTickRef.current;
      lastTickRef.current = now;
      setElapsed(elapsedRef.current);
      setClipBytes(chunksRef.current.reduce((acc, b) => acc + b.size, 0));
    }, 100);
  }, []);

  const pauseChrono = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  /* ============ SÍNTESIS DE VOZ (Salida) ============
   * Decisiones de diseño (problemas reportados en S25 Ultra):
   *
   *  · Antes de hablar, hacemos un "warm-up" de salida: reproducimos
   *    ~100 ms de silencio por un <audio> con setSinkId aplicado al
   *    dispositivo de salida elegido. En Android, este truco "engancha"
   *    el destino BT / USB-C; sin él, speechSynthesis puede salir por
   *    el altavoz del teléfono.
   *
   *  · Watchdog basado en **polling de synth.speaking cada 500 ms**
   *    (no en `onboundary`, que algunos navegadores no disparan). Si
   *    el utterance dejó de hablar sin disparar `onend`, lo detectamos
   *    y finalizamos para que la página no quede muda.
   *
   *  · El viejo keepAlive (pause/resume cada 8 s) se eliminó: en
   *    muchos Androids era lo que cortaba el utterance a mitad de frase.
   * ============================================================ */
  const speakWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakStartTsRef = useRef(0);
  /** true mientras el utterance está hablando, según el motor del sistema. */
  const speakActuallyPlayingRef = useRef(false);
  /** Duración estimada del utterance (texto / 14 cps ≈ tiempo en ms). */
  const speakEstimatedMsRef = useRef(0);
  /** Trozos de la respuesta (oraciones). Cada uno es una utterance aparte. */
  const textPartsRef = useRef<string[]>([]);
  /** Índice del trozo que se está hablando o se va a hablar. */
  const partIndexRef = useRef(0);
  /** true cuando hicimos synth.cancel() nosotros; el onend no debe
   *  avanzar al siguiente chunk en ese caso. */
  const isCancelingRef = useRef(false);
  /** Ref a speakPart() para que onVoiceButton (resume) pueda continuar
   *  la cadena de utterances sin recrear el closure. */
  const speakPartRef = useRef<(() => void) | null>(null);

  const stopWatchdog = useCallback(() => {
    if (speakWatchdogRef.current) {
      clearInterval(speakWatchdogRef.current);
      speakWatchdogRef.current = null;
    }
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!("speechSynthesis" in window)) return;
      const synth = window.speechSynthesis;
      synth.cancel(); // corta cualquier lectura previa
      stopWatchdog();
      speakActuallyPlayingRef.current = false;
      userPausedRef.current = false;
      isCancelingRef.current = false;

      // Limpiamos el markdown antes de trocear: el TTS lee literal
      // los asteriscos/guiones de sintaxis y suena muy mal.
      const cleaned = cleanForTTS(text);

      // Troceamos por oraciones (después de '.', '!', '?', o salto de
      // línea). Cada trozo es una utterance aparte, así el pause/resume
      // es robusto: cancelamos SOLO el trozo actual y al reanudar
      // empezamos el siguiente con un utterance nuevo (no dependemos
      // del synth.resume() que en Chrome Android suele dejar muda la
      // utterance).
      const parts = cleaned
        .split(/(?<=[.!?\n])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      textPartsRef.current = parts.length > 0 ? parts : [text];
      partIndexRef.current = 0;
      const totalChars = textPartsRef.current.reduce((acc, p) => acc + p.length, 0);
      // Estimación cruda: ~13 caracteres por segundo en español a rate=0.9.
      speakEstimatedMsRef.current = Math.max(2000, (totalChars / 13) * 1000);

      // Cierra toda la reproducción y vuelve a idle.
      const finishAll = (reason: string) => {
        stopWatchdog();
        speakActuallyPlayingRef.current = false;
        if (phaseRef.current === "speaking" || phaseRef.current === "voicePaused") {
          goPhase("idle");
          setStatus("Listo — presiona Grabar para otra pregunta");
        }
        if (typeof console !== "undefined" && reason) {
          // eslint-disable-next-line no-console
          console.debug(`[gem] speak finished (${reason})`);
        }
      };

      // Habla el chunk actual. Si terminó naturalmente, pasa al
      // siguiente. Si fue por nuestro cancel() o pause, no avanza.
      const speakPart = () => {
        if (partIndexRef.current >= textPartsRef.current.length) {
          finishAll("all parts done");
          return;
        }
        // Si el usuario pausó o cancelamos, no seguimos.
        if (phaseRef.current === "idle" || userPausedRef.current) return;
        const partText = textPartsRef.current[partIndexRef.current];
        const u = new SpeechSynthesisUtterance(partText);
        u.lang = "es-ES";
        const v = pickSpanishVoice(voicesRef.current);
        if (v) u.voice = v;
        u.rate = 0.9;
        u.pitch = 1;
        u.volume = 1;
        utterRef.current = u;

        u.onstart = () => {
          speakStartTsRef.current = Date.now();
          speakActuallyPlayingRef.current = true;
          if (phaseRef.current !== "voicePaused") {
            goPhase("speaking");
            setStatus("Respondiendo…");
          }
        };
        u.onend = () => {
          // Si fue por nuestro cancel() o pause, no avanzamos.
          if (isCancelingRef.current) {
            isCancelingRef.current = false;
            return;
          }
          partIndexRef.current += 1;
          if (partIndexRef.current < textPartsRef.current.length) {
            // Pequeño delay entre partes para que el motor respire.
            setTimeout(() => speakPart(), 40);
          } else {
            finishAll("onend (last part)");
          }
        };
        u.onerror = (e) => {
          if (e.error === "canceled" || e.error === "interrupted") {
            // No avanzar: el cancel puede venir del pause o de un reinicio.
            return;
          }
          finishAll(`onerror: ${e.error || "unknown"}`);
        };

        try {
          synth.speak(u);
        } catch {
          finishAll("speak threw");
        }
      };
      // Expongo speakPart para que onVoiceButton (en el resume) pueda
      // continuar la cadena con una utterance nueva.
      speakPartRef.current = speakPart;

      // Warm-up de salida ANTES de pedir al sistema que hable.
      void warmupOutput().then(async () => {
        await new Promise((r) => setTimeout(r, 60));
        speakPart();
      });

      // Watchdog por polling.
      let consecutiveQuiet = 0;
      speakWatchdogRef.current = setInterval(() => {
        if (phaseRef.current !== "speaking" && phaseRef.current !== "voicePaused") {
          stopWatchdog();
          return;
        }
        if (userPausedRef.current || synth.paused) {
          consecutiveQuiet = 0;
          return;
        }
        const isSpeaking = synth.speaking;
        if (isSpeaking) {
          speakActuallyPlayingRef.current = true;
          consecutiveQuiet = 0;
        } else {
          consecutiveQuiet += 1;
          if (consecutiveQuiet >= 3) {
            try {
              isCancelingRef.current = true;
              synth.cancel();
            } catch {
              /* no-op */
            }
            finishAll(`watchdog: synth.speaking false ${consecutiveQuiet * 500}ms`);
            return;
          }
        }
        const elapsed = Date.now() - speakStartTsRef.current;
        if (speakStartTsRef.current > 0 && elapsed > speakEstimatedMsRef.current * 2 + 5000) {
          try {
            isCancelingRef.current = true;
            synth.cancel();
          } catch {
            /* no-op */
          }
          finishAll("watchdog: > 2x estimación");
        }
      }, 500);
    },
    [goPhase, stopWatchdog]
  );

  /* Limpia el watchdog al desmontar. */
  useEffect(() => {
    return () => stopWatchdog();
  }, [stopWatchdog]);

  /* ============ BOTÓN 1 · GRABAR / PAUSAR / REANUDAR ============ */

  /** Detiene pistas y desconecta nodos del micrófono anterior. */
  const teardownMic = useCallback(() => {
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {
      /* ya inactivo */
    }
    recorderRef.current = null;
    mediaSourceRef.current?.disconnect();
    mediaSourceRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /**
   * RESET LIMPIO (punto 5 del spec): inicia una sesión de grabación
   * totalmente independiente de la anterior, sin recargar la página.
   */
  const beginNewSession = useCallback(async () => {
    // 1) Cancelar cualquier reproducción de voz en curso
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    keepAliveRef.current = null;

    // 2) Limpiar el arreglo de audio anterior
    chunksRef.current = [];
    setClipBytes(0);
    sendRequestedRef.current = false;

    clearAllIntervals();
    teardownMic();
    elapsedRef.current = 0;
    setElapsed(0);
    setError("");
    setErrorDetail("");

    goPhase("starting");
    setStatus("Solicitando micrófono…");
    setActiveMicLabel("");
    setMicDiagnostic("");

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints());
      } catch (err) {
        // Si el `deviceId: { exact }` no funciona (dispositivo desconectado,
        // driver que no acepta el constraint, etc.), caemos al default
        // del sistema. La página sigue funcionando; el usuario ve un
        // diagnóstico claro.
        const name = (err as { name?: string })?.name;
        if (name === "OverconstrainedError" || name === "NotFoundError") {
          setMicDiagnostic(
            "El dispositivo seleccionado no está disponible. Se usó el micrófono predeterminado del sistema."
          );
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw err;
        }
      }
      streamRef.current = stream;

      // Leemos el nombre real del dispositivo que el stream está usando.
      const track = stream.getAudioTracks()[0];
      if (track) {
        const settings = track.getSettings?.() ?? {};
        const label = (settings as { label?: string }).label || track.label || "Micrófono activo";
        setActiveMicLabel(label);
        // Si el stream terminó usando un deviceId distinto al que el
        // usuario eligió (porque el exact falló), lo sincronizamos.
        const usedId = (settings as { deviceId?: string }).deviceId;
        if (usedId && usedId !== selectedInputId) {
          setSelectedInputId(usedId);
          saveInputId(usedId);
        }
      }

      // Apenas conseguimos un stream válido, los labels de los
      // dispositivos pasan a ser legibles. Refrescamos la lista para
      // que el selector muestre el nombre real del receptor USB/BT.
      try {
        const d = await startDeviceWatcher();
        setInputDevices(d.inputs);
        setOutputDevices(d.outputs);
      } catch {
        /* enumeración opcional */
      }

      // Analizador para el osciloscopio (comparte el AudioContext de los beeps)
      const actx = ensureAudio();
      const src = actx.createMediaStreamSource(stream);
      const analyser = actx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      mediaSourceRef.current = src;
      analyserRef.current = analyser;

      // 3) NUEVA instancia de MediaRecorder → clip 100% independiente
      if (typeof MediaRecorder === "undefined") {
        throw new Error("Este navegador no soporta MediaRecorder.");
      }
      const mime = pickMimeType();
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream, { mimeType: mime });
      } catch {
        rec = new MediaRecorder(stream);
      }
      mimeRef.current = rec.mimeType || mime;

      // Cada timeslice aporta un pedazo; pause()/resume() no pierden nada:
      // todo se acumula en chunksRef hasta formar UN solo Blob.
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        void handleRecorderStopped();
      };
      recorderRef.current = rec;
      rec.start(250);

      // 4) Estado visual → "Grabando…"
      goPhase("recording");
      setStatus("Grabando…");
      sfx.recStart(); // beep agudo de inicio
      tickRef.current = setInterval(() => sfx.recTick(), 2000); // beep cada 2 s
      startChrono();
    } catch (err) {
      sfx.error();
      goPhase("idle");
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setStatus("En espera");
        setError("Permiso de micrófono denegado. Actívalo en la barra del navegador y vuelve a intentarlo.");
        setErrorDetail("");
      } else if (name === "NotFoundError") {
        setStatus("En espera");
        setError("No se detectó ningún micrófono en este equipo.");
        setErrorDetail("");
      } else {
        setStatus("En espera");
        setError((err as Error)?.message || "No se pudo iniciar la grabación.");
        setErrorDetail("");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearAllIntervals, teardownMic, goPhase, startChrono, buildAudioConstraints]);

  /**
   * Acción del Botón 1 según la fase actual.
   * El botón NUNCA se mueve ni cambia de tamaño: solo su etiqueta.
   */
  const onRecordButton = useCallback(() => {
    const p = phaseRef.current;
    if (p === "recording") {
      // Pausar: el clip queda "abierto", sin perder lo acumulado
      try {
        recorderRef.current?.pause();
      } catch {
        return;
      }
      goPhase("paused");
      setStatus("Grabación en pausa — puedes leer en silencio");
      sfx.recPause(); // beep grave
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
      pauseChrono();
    } else if (p === "paused") {
      // Reanudar: mismo recorder, mismo Blob destino
      try {
        recorderRef.current?.resume();
      } catch {
        return;
      }
      goPhase("recording");
      setStatus("Grabando…");
      sfx.recStart();
      tickRef.current = setInterval(() => sfx.recTick(), 2000);
      startChrono();
    } else if (p === "idle" || p === "speaking" || p === "voicePaused") {
      // Nueva pregunta → reset limpio del ciclo completo
      void beginNewSession();
    }
    // En 'sending' / 'processing' / 'starting' el botón está deshabilitado
  }, [beginNewSession, goPhase, pauseChrono, startChrono]);

  /* ============ BOTÓN 2 · ENVIAR A GEMINI ============ */

  /** Cuando el recorder se detiene tras pedir envío, arma el Blob y procesa. */
  const handleRecorderStopped = useCallback(async () => {
    if (!sendRequestedRef.current) return; // stop sin envío (reset) → ignorar
    sendRequestedRef.current = false;

    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    chunksRef.current = [];
    pauseChrono();
    teardownMic(); // libera el micrófono entre sesiones

    if (blob.size === 0) {
      sfx.error();
      goPhase("idle");
      setStatus("En espera");
      setError("No se capturó audio. Verifica el micrófono y graba de nuevo.");
      return;
    }

    goPhase("processing");
    setStatus("Procesando con Gemini…");
    sfx.think();
    thinkRef.current = setInterval(() => sfx.think(), 1000); // beep suave cada segundo

    try {
      const base64 = await blobToBase64(blob);
      const effectiveKey = (keyRef.current || GEMINI_API_KEY).trim();
      if (effectiveKey === "TU_API_KEY_AQUI") {
        throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
      }
      const text = await askGemini(base64, mimeRef.current, effectiveKey);

      if (thinkRef.current) clearInterval(thinkRef.current);
      thinkRef.current = null;

      responseRef.current = text;
      setResponse(text);
      setError("");
      setErrorDetail("");
      setHistory((h) =>
        [
          {
            id: Date.now(),
            time: new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }),
            text,
          },
          ...h,
        ].slice(0, 8)
      );

      sfx.ready(); // beep alegre: respuesta lista
      speak(text); // lectura automática en voz alta
    } catch (err) {
      if (thinkRef.current) clearInterval(thinkRef.current);
      thinkRef.current = null;
      sfx.error();
      goPhase("idle");
      setStatus("En espera");
      if (err instanceof GeminiError) {
        setError(err.message);
        setErrorDetail(err.detail || "");
      } else {
        setError((err as Error)?.message || "Ocurrió un error inesperado al procesar el audio.");
        setErrorDetail("");
      }
    }
  }, [goPhase, pauseChrono, teardownMic, speak]);

  /**
   * Acción del Botón 2: detiene la grabación (esté grabando o en pausa)
   * y dispara el envío. Solo está habilitado cuando hay audio acumulado.
   */
  const onSendButton = useCallback(() => {
    const p = phaseRef.current;
    if (p !== "recording" && p !== "paused") return;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    sendRequestedRef.current = true;
    goPhase("sending");
    setStatus("Enviando audio…");
    sfx.send(); // doble beep ascendente
    try {
      recorderRef.current?.stop(); // → onstop → handleRecorderStopped
    } catch {
      void handleRecorderStopped();
    }
  }, [goPhase, handleRecorderStopped]);

  /* ============ BOTÓN 3 · PLAY / PAUSA DE LA VOZ ============
   *
   * Con el chunking por oraciones, el pause/resume es robusto:
   *  - Pausa: cancela la utterance actual (se pierde la oración en
   *    curso, pero al ser oraciones cortas es poco). El índice NO
   *    avanza: al reanudar, repetimos esa misma oración.
   *  - Play: crea una utterance nueva con la oración actual. No
   *    dependemos de synth.resume() (que en Chrome Android suele
   *    dejar la utterance muda).
   */
  const onVoiceButton = useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const p = phaseRef.current;

    if (p === "speaking") {
      // Marcar que el cancel viene de nosotros para que el onend no
      // avance al siguiente chunk.
      isCancelingRef.current = true;
      userPausedRef.current = true;
      try {
        synth.cancel();
      } catch {
        /* no-op */
      }
      goPhase("voicePaused");
      setStatus("Lectura en pausa");
    } else if (p === "voicePaused") {
      // Reanudar: el speakPartRef.current() habla el chunk actual con
      // una utterance NUEVA. No usamos synth.resume() porque en
      // Chrome Android suele dejar la utterance muda.
      userPausedRef.current = false;
      isCancelingRef.current = false;
      goPhase("speaking");
      setStatus("Respondiendo…");
      // Pequeño delay para evitar carreras con el cancel anterior.
      setTimeout(() => speakPartRef.current?.(), 80);
    } else if (responseRef.current) {
      // Lectura terminada → reproducir de nuevo desde el principio.
      // Cleanup agresivo: a veces el speechSynthesis de Chrome deja
      // una utterance fantasma (sobre todo después de varias pausas)
      // y la siguiente no se oye aunque la UI diga "Respondiendo…".
      // Cancelamos de nuevo y esperamos un poco antes de arrancar.
      sfx.ready();
      try {
        synth.cancel();
      } catch {
        /* no-op */
      }
      setTimeout(() => speak(responseRef.current), 120);
    }
  }, [goPhase, speak]);

  /* ============ Acciones secundarias ============ */

  const toggleMute = useCallback(() => {
    setMutedUi((m) => {
      const next = !m;
      store.set("gem-muted", next ? "1" : "0");
      return next;
    });
  }, []);

  const saveKey = useCallback(() => {
    const clean = keyInput.trim();
    setSavedKey(clean);
    store.set("gem-api-key", clean);
    setKeySavedFlash(true);
    setTimeout(() => setKeySavedFlash(false), 1800);
  }, [keyInput]);

  const playHistoryItem = useCallback(
    (item: HistoryItem) => {
      responseRef.current = item.text;
      setResponse(item.text);
      sfx.ready();
      speak(item.text);
    },
    [speak]
  );

  /* ----- Derivados para la UI ----- */
  const effectiveKey = (savedKey || GEMINI_API_KEY).trim();
  const keyConfigured = effectiveKey !== "TU_API_KEY_AQUI";
  const hasAudio = phase === "recording" || phase === "paused";
  const canVoice = phase === "speaking" || phase === "voicePaused" || (response !== "" && phase === "idle");
  const waveMode: WaveMode = phase === "recording" || phase === "sending" ? "live" : phase === "paused" ? "paused" : "idle";
  const getAnalyser = useCallback(() => analyserRef.current, []);
  const wordCount = response.trim() ? response.trim().split(/\s+/).length : 0;

  const recordLabel = phase === "recording" ? "Pausar" : phase === "paused" ? "Reanudar" : "Grabar";
  const voiceLabel = phase === "speaking" ? "Pausar voz" : phase === "voicePaused" ? "Reanudar voz" : "Escuchar";

  /* ============================================================
     RENDER
     ============================================================ */
  return (
    <div className="min-h-screen">
      {/* Fondo ambiental por capas */}
      <div className="gem-bg" aria-hidden>
        <div className="drift drift-a" />
        <div className="drift drift-b" />
      </div>

      {/* ---------- Encabezado ---------- */}
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 pb-4 pt-6 sm:px-6">
        <h1 className="font-display text-2xl font-bold tracking-[0.18em] text-[#c4b5fd] sm:text-3xl">
          Asis. 91
        </h1>
        <div className="flex items-center gap-2">
          <span
            className={`hidden items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono-gem text-[10px] uppercase tracking-widest sm:flex ${
              keyConfigured
                ? "border-[#3ddc97]/40 text-[#3ddc97]"
                : "border-[#ffc24b]/50 text-[#ffc24b]"
            }`}
          >
            <KeyIcon size={13} />
            {keyConfigured ? "Key activa" : "Falta API Key"}
          </span>
          {/* Silenciar feedbacks (esquina) */}
          <button
            type="button"
            onClick={toggleMute}
            title={muted ? "Activar sonidos" : "Silenciar sonidos"}
            aria-label={muted ? "Activar sonidos" : "Silenciar sonidos"}
            className="ctrl-btn grid h-10 w-10 place-items-center rounded-xl border border-[#1e3b41] bg-[#0f2226] text-[#8fb0ac] hover:border-[#4cc9d4]/60 hover:text-[#e9f4f1]"
          >
            {muted ? <SpeakerOffIcon size={19} /> : <SpeakerOnIcon size={19} />}
          </button>
        </div>
      </header>

      {/* ---------- FILA DE CONTROLES: 3 botones fijos, siempre iguales ---------- */}
      <div className="sticky top-0 z-30 border-y border-[#1e3b41] bg-[#0a1619]/85 backdrop-blur-md">
        <div className="mx-auto grid max-w-6xl grid-cols-3 gap-2.5 px-4 py-3 sm:gap-3 sm:px-6">
          {/* Botón 1 · Grabar / Pausar / Reanudar */}
          <ControlButton
            accent="coral"
            icon={phase === "recording" || phase === "paused" ? <PauseIcon size={26} /> : <MicIcon size={26} />}
            label={recordLabel}
            hint="un solo clip"
            onClick={onRecordButton}
            disabled={phase === "sending" || phase === "processing" || phase === "starting"}
            active={phase === "recording"}
          />
          {/* Botón 2 · Enviar (solo con audio grabado) */}
          <ControlButton
            accent="cyan"
            icon={<SendIcon size={26} />}
            label="Enviar"
            hint="a gemini"
            onClick={onSendButton}
            disabled={!hasAudio}
          />
          {/* Botón 3 · Play / Pausa de la respuesta */}
          <ControlButton
            accent="mint"
            icon={phase === "speaking" ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
            label={voiceLabel}
            hint="respuesta"
            onClick={onVoiceButton}
            disabled={!canVoice}
          />
        </div>
      </div>

      {/* ---------- Cuerpo principal ---------- */}
      <main className="mx-auto grid max-w-6xl gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[1fr_360px]">
        {/* Columna izquierda: consola + respuesta */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Consola de grabación */}
          <section className="rounded-xl border border-[#1e3b41] bg-[#0f2226] p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <StatusDot phase={phase} />
                <p className="text-sm font-medium text-[#e9f4f1]">{status}</p>
                {phase === "speaking" && <Equalizer />}
              </div>
              <div className="flex items-center gap-3 font-mono-gem text-xs text-[#8fb0ac]">
                <span className={phase === "recording" ? "text-[#ff6b5e]" : phase === "paused" ? "text-[#ffc24b]" : ""}>
                  {formatTime(elapsed)}
                </span>
                <span className="hidden rounded border border-[#1e3b41] px-1.5 py-0.5 text-[10px] sm:inline">
                  {formatBytes(clipBytes)}
                </span>
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-[#1e3b41]/70 bg-[#0a1619]/70">
              <Waveform getAnalyser={getAnalyser} mode={waveMode} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac]">
              <span>
                Canal <b className="text-[#e9f4f1]">mic</b>
              </span>
              <span className="text-center">
                Modo <b className="text-[#e9f4f1]">{hasAudio ? "acumular" : "reposo"}</b>
              </span>
              <span className="text-right">
                Clip <b className="text-[#e9f4f1]">{hasAudio ? "abierto" : "—"}</b>
              </span>
            </div>
          </section>

          {/* Área de texto: estado + respuesta de la IA */}
          <section className="flex-1 rounded-xl border border-[#1e3b41] bg-[#0f2226] p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-[#8fb0ac]">
                Respuesta del asistente
              </h2>
              {wordCount > 0 && (
                <span className="font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac]">
                  ≈ {wordCount} palabras
                </span>
              )}
            </div>

            {/* Error discreto */}
            {error && (
              <div className="answer-in mb-3 flex items-start gap-2.5 rounded-lg border border-[#ff6b5e]/40 bg-[#ff6b5e]/10 px-3.5 py-3 text-sm text-[#ffb4ad]">
                <AlertIcon size={18} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p>{error}</p>
                  {errorDetail && (
                    <details className="mt-2">
                      <summary className="cursor-pointer select-none font-mono-gem text-[10px] uppercase tracking-widest text-[#ffb4ad]/70 transition-colors hover:text-[#ffb4ad]">
                        Detalle técnico
                      </summary>
                      <p className="mt-1.5 break-words font-mono-gem text-[11px] leading-relaxed text-[#ffb4ad]/80">
                        {errorDetail}
                      </p>
                    </details>
                  )}
                </div>
              </div>
            )}

            {phase === "processing" || phase === "sending" ? (
              <div className="answer-in space-y-3 py-2">
                {[92, 100, 78].map((w, i) => (
                  <div key={i} className="h-3 animate-pulse rounded-full bg-[#122a2f]" style={{ width: `${w}%` }} />
                ))}
                <p className="pt-1 font-mono-gem text-xs text-[#8fb0ac]">
                  {phase === "sending" ? "Codificando audio en Base64…" : "Gemini está escuchando tu clip…"}
                </p>
              </div>
            ) : response ? (
              <p className="answer-in whitespace-pre-wrap text-[15px] leading-relaxed text-[#e9f4f1]">{response}</p>
            ) : (
              <div className="py-6 text-center">
                <p className="mx-auto max-w-md text-sm leading-relaxed text-[#8fb0ac]">
                  Presiona <b className="text-[#ff6b5e]">Grabar</b> y formula tu pregunta en voz alta. Puedes{" "}
                  <b className="text-[#ffc24b]">pausar</b> para leer y <b className="text-[#ff6b5e]">reanudar</b>: todo se
                  acumula en un solo clip. Luego <b className="text-[#4cc9d4]">Envía</b> y escucha la respuesta.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* Columna derecha: bitácora + configuración */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Bitácora de sesión */}
          <section className="rounded-xl border border-[#1e3b41] bg-[#0f2226] p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-display text-xs font-semibold uppercase tracking-[0.2em] text-[#8fb0ac]">
                <HistoryIcon size={15} /> Bitácora
              </h2>
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={() => setHistory([])}
                  className="ctrl-btn flex items-center gap-1.5 rounded-md border border-[#1e3b41] px-2 py-1 font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac] hover:border-[#ff6b5e]/50 hover:text-[#ff6b5e]"
                >
                  <TrashIcon size={12} /> Limpiar
                </button>
              )}
            </div>
            {history.length === 0 ? (
              <p className="py-3 text-center font-mono-gem text-xs text-[#8fb0ac]/70">
                Las respuestas de esta sesión aparecerán aquí.
              </p>
            ) : (
              <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
                {history.map((item, i) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => playHistoryItem(item)}
                      className="ctrl-btn w-full rounded-lg border border-[#1e3b41] bg-[#122a2f]/60 px-3 py-2.5 text-left hover:border-[#3ddc97]/50"
                      title="Escuchar de nuevo"
                    >
                      <span className="flex items-center justify-between font-mono-gem text-[10px] uppercase tracking-widest text-[#3ddc97]">
                        <span>R{history.length - i} · {item.time}</span>
                        <PlayIcon size={11} className="text-[#8fb0ac]" />
                      </span>
                      <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-[#cfe0dd]">
                        {item.text}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Configuración */}
          <section className="rounded-xl border border-[#1e3b41] bg-[#0f2226] p-4 sm:p-5">
            <h2 className="mb-3 flex items-center gap-2 font-display text-xs font-semibold uppercase tracking-[0.2em] text-[#8fb0ac]">
              <KeyIcon size={15} /> Configuración
            </h2>

            <label className="mb-1 block font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac]" htmlFor="gem-mic">
              Micrófono de entrada
            </label>
            <div className="mb-2 flex gap-2">
              <select
                id="gem-mic"
                value={selectedInputId ?? ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setSelectedInputId(v);
                  saveInputId(v);
                  setMicDiagnostic("");
                }}
                className="min-w-0 flex-1 rounded-lg border border-[#1e3b41] bg-[#0a1619] px-3 py-2 font-mono-gem text-xs text-[#e9f4f1] outline-none transition-colors focus:border-[#4cc9d4]/60"
              >
                <option value="">Predeterminado del sistema</option>
                {inputDevices.map((d, i) => (
                  <option key={d.deviceId || `in-${i}`} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const d = await startDeviceWatcher();
                    setInputDevices(d.inputs);
                    setOutputDevices(d.outputs);
                  } catch {
                    /* no-op */
                  }
                }}
                className="ctrl-btn rounded-lg border border-[#1e3b41] bg-[#0a1619] px-3 py-2 text-xs font-semibold text-[#8fb0ac] hover:border-[#4cc9d4]/60 hover:text-[#e9f4f1]"
                title="Reescanear dispositivos (útil después de conectar/desconectar USB-C o BT)"
              >
                Re-escanear
              </button>
            </div>
            {activeMicLabel && (
              <p className="mb-1 -mt-1 font-mono-gem text-[10px] uppercase tracking-widest text-[#3ddc97]">
                ● {activeMicLabel}
              </p>
            )}
            {micDiagnostic && (
              <p className="mb-2 -mt-1 text-[11px] leading-relaxed text-[#ffc24b]">{micDiagnostic}</p>
            )}
            <p className="mb-3 -mt-1 text-[11px] leading-relaxed text-[#8fb0ac]">
              Si usás un mic corbatero por USB-C o Bluetooth, elegilo acá y presioná
              <b> Re-escanear</b> después de enchufarlo. La próxima grabación lo va a tomar.
            </p>

            <label className="mb-1 block font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac]" htmlFor="gem-out">
              Salida de audio (auriculares / BT)
            </label>
            <div className="mb-3 flex gap-2">
              <select
                id="gem-out"
                value={selectedOutputId ?? ""}
                onChange={(e) => {
                  const v = e.target.value || null;
                  setSelectedOutputId(v);
                  saveOutputId(v);
                }}
                className="min-w-0 flex-1 rounded-lg border border-[#1e3b41] bg-[#0a1619] px-3 py-2 font-mono-gem text-xs text-[#e9f4f1] outline-none transition-colors focus:border-[#4cc9d4]/60"
                title={
                  supportsOutputSelection() || supportsAudioContextSinkId()
                    ? "Cambia la salida de los sonidos de la web y de la voz del asistente"
                    : "Este navegador no permite elegir dispositivo de salida — se usará el predeterminado del sistema"
                }
              >
                <option value="">Predeterminada del sistema</option>
                {outputDevices.map((d, i) => (
                  <option key={d.deviceId || `out-${i}`} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  void warmupOutput();
                  sfx.ready();
                }}
                className="ctrl-btn rounded-lg border border-[#3ddc97]/50 bg-[#3ddc97]/10 px-3 py-2 text-xs font-semibold text-[#3ddc97] hover:bg-[#3ddc97]/20"
                title="Reproduce un sonido corto por el dispositivo elegido"
              >
                Probar
              </button>
            </div>
            <p className="mb-4 -mt-2 text-[11px] leading-relaxed text-[#8fb0ac]">
              Seleccioná los auriculares o el dispositivo Bluetooth/USB-C. La voz del
              asistente y los beeps de feedback saldrán por acá.
            </p>

            <label className="mb-1 block font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac]" htmlFor="gem-key">
              API Key de Gemini
            </label>
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  id="gem-key"
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={keyConfigured ? "•••••••• (guardada)" : "Pega tu llave aquí"}
                  className="w-full rounded-lg border border-[#1e3b41] bg-[#0a1619] px-3 py-2 pr-10 font-mono-gem text-xs text-[#e9f4f1] placeholder:text-[#8fb0ac]/50 outline-none transition-colors focus:border-[#4cc9d4]/60"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  aria-label={showKey ? "Ocultar llave" : "Mostrar llave"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8fb0ac] hover:text-[#e9f4f1]"
                >
                  {showKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                </button>
              </div>
              <button
                type="button"
                onClick={saveKey}
                className="ctrl-btn rounded-lg border border-[#4cc9d4]/50 bg-[#4cc9d4]/10 px-3.5 py-2 text-xs font-semibold text-[#4cc9d4] hover:bg-[#4cc9d4]/20"
              >
                Guardar
              </button>
            </div>
            <p className={`mt-2 text-[11px] leading-relaxed ${keySavedFlash ? "text-[#3ddc97]" : "text-[#8fb0ac]"}`}>
              {keySavedFlash
                ? "Llave guardada en este navegador ✓"
                : keyConfigured
                  ? "Usando la llave guardada en este navegador. También puedes fijarla en la constante GEMINI_API_KEY."
                  : "Sin llave aún: pégala arriba o edita la constante GEMINI_API_KEY en src/lib/gemini.ts."}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-[#1e3b41] bg-[#122a2f]/60 px-3 py-2.5">
                <p className="font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac]">Feedback sonoro</p>
                <button type="button" onClick={toggleMute} className="ctrl-btn mt-1 flex items-center gap-1.5 text-xs font-semibold text-[#e9f4f1]">
                  {muted ? <SpeakerOffIcon size={14} className="text-[#ff6b5e]" /> : <SpeakerOnIcon size={14} className="text-[#3ddc97]" />}
                  {muted ? "Silenciado" : "Activado"}
                </button>
              </div>
              <div className="rounded-lg border border-[#1e3b41] bg-[#122a2f]/60 px-3 py-2.5">
                <p className="font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac]">Volumen sfx</p>
                <p className="mt-1 font-mono-gem text-xs font-semibold text-[#ffc24b]">SOUND_VOLUME = {SOUND_VOLUME}</p>
              </div>
            </div>

            <details className="group mt-4 rounded-lg border border-[#1e3b41] bg-[#0a1619]/60">
              <summary className="cursor-pointer select-none px-3 py-2.5 font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac] transition-colors hover:text-[#e9f4f1]">
                Prompt del sistema ▾
              </summary>
              <p className="border-t border-[#1e3b41] px-3 py-2.5 text-xs italic leading-relaxed text-[#cfe0dd]">
                “{SYSTEM_PROMPT}”
              </p>
            </details>
          </section>
        </div>
      </main>

      {/* ---------- Guía de despliegue (3 pasos) ---------- */}
      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-6 sm:px-6">
        <Reveal>
          <div className="rounded-xl border border-[#1e3b41] bg-[#0f2226] p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-2.5">
              <GlobeIcon size={18} className="text-[#4cc9d4]" />
              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-[#e9f4f1]">
                Publicar en GitHub Pages · sin terminal
              </h2>
            </div>
            <ol className="grid gap-3 md:grid-cols-3">
              <li className="rounded-lg border border-[#1e3b41] bg-[#122a2f]/60 p-4 transition-colors hover:border-[#4cc9d4]/50">
                <span className="flex items-center gap-2">
                  <GitBranchIcon size={16} className="text-[#4cc9d4]" />
                  <span className="font-display text-xs font-semibold text-[#4cc9d4]">1 · Creá el repo</span>
                </span>
                <p className="mt-2 text-xs leading-relaxed text-[#cfe0dd]">
                  Entrá a{" "}
                  <code className="rounded bg-[#0a1619] px-1.5 py-0.5 font-mono-gem text-[#ffc24b]">github.com/new</code>, poné un
                  nombre (ej. <code className="rounded bg-[#0a1619] px-1.5 py-0.5 font-mono-gem text-[#ffc24b]">asistente-gem</code>
                  ), elegí <b>Público</b> y tocá <b>Create repository</b>. No instalás nada.
                </p>
              </li>
              <li className="rounded-lg border border-[#1e3b41] bg-[#122a2f]/60 p-4 transition-colors hover:border-[#3ddc97]/50">
                <span className="flex items-center gap-2">
                  <UploadIcon size={16} className="text-[#3ddc97]" />
                  <span className="font-display text-xs font-semibold text-[#3ddc97]">2 · Subí los archivos</span>
                </span>
                <p className="mt-2 text-xs leading-relaxed text-[#cfe0dd]">
                  En el repo: <b>Add file → Upload files</b>. Arrastrá los archivos del proyecto (
                  <b>sin</b> <code className="rounded bg-[#0a1619] px-1.5 py-0.5 font-mono-gem text-[#ffc24b]">node_modules</code> ni{" "}
                  <code className="rounded bg-[#0a1619] px-1.5 py-0.5 font-mono-gem text-[#ffc24b]">dist</code>) y tocá{" "}
                  <b>Commit changes</b>. El workflow incluido hace que GitHub compile solo.
                </p>
              </li>
              <li className="rounded-lg border border-[#1e3b41] bg-[#122a2f]/60 p-4 transition-colors hover:border-[#ff6b5e]/50">
                <span className="flex items-center gap-2">
                  <ZapIcon size={16} className="text-[#ff6b5e]" />
                  <span className="font-display text-xs font-semibold text-[#ff6b5e]">3 · Activá Pages</span>
                </span>
                <p className="mt-2 text-xs leading-relaxed text-[#cfe0dd]">
                  <b>Settings → Pages</b> y en <b>Source</b> elegí <b>GitHub Actions</b>. Listo: tu consola queda en{" "}
                  <code className="rounded bg-[#0a1619] px-1.5 py-0.5 font-mono-gem text-[#ffc24b]">usuario.github.io/asistente-gem</code>
                  .
                </p>
              </li>
            </ol>
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-[#3ddc97]/30 bg-[#3ddc97]/5 px-3.5 py-3">
              <ZapIcon size={15} className="mt-0.5 shrink-0 text-[#3ddc97]" />
              <p className="text-xs leading-relaxed text-[#cfe0dd]">
                <b className="text-[#3ddc97]">Deploy automático:</b> cada vez que subas un archivo modificado, GitHub recompila y
                republica solo en ~1 minuto (lo ves en la pestaña <b>Actions</b> del repo). El paso 3 se hace una única vez.
              </p>
            </div>
            <p className="mt-4 font-mono-gem text-[10px] uppercase tracking-widest text-[#8fb0ac]/70">
              100% frontend · sin comandos · GitHub Actions compila por vos
            </p>
          </div>
        </Reveal>
        <p className="mt-5 text-center font-mono-gem text-[10px] uppercase tracking-[0.2em] text-[#8fb0ac]/60">
          Asistente GEM · herramienta personal de estudio
        </p>
      </footer>
    </div>
  );
}
