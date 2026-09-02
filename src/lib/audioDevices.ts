/* ============================================================
   GESTIÓN DE DISPOSITIVOS DE AUDIO
   ------------------------------------------------------------
   Chrome en Android expone `navigator.mediaDevices.enumerateDevices()`
   solo después de que la página haya obtenido al menos un permiso
   de captura (getUserMedia). Si llamamos a enumerateDevices()
   antes de conceder permiso, los `label` vienen vacíos y la lista
   muestra solo "Dispositivo 1", "Dispositivo 2" sin identificar.

   Por eso:
     · Antes del primer permiso, devolvemos una lista vacía.
     · Apenas conseguimos un stream válido, refrescamos la lista
       y emitimos un cambio con labels legibles.
     · Escuchamos `devicechange` para mantener la lista viva
       (los BT se conectan/desconectan en caliente).

   Persistencia: las selecciones se guardan en localStorage con
   dos claves separadas para entrada y salida, de modo que el
   usuario solo configura una vez.
   ============================================================ */

const LS_INPUT = "gem-audio-input";
const LS_OUTPUT = "gem-audio-output";

/** Representa un dispositivo físico o virtual que el navegador ve. */
export interface AudioDevice {
  deviceId: string;
  label: string;
  /** "audioinput" | "audiooutput" — útil para filtrar. */
  kind: MediaDeviceKind;
}

/** `true` si el navegador soporta asignar dispositivo de salida
 *  a un HTMLMediaElement (setSinkId). Chrome desktop y Chrome
 *  Android 110+ lo soportan; Samsung Internet y otros pueden no. */
export function supportsOutputSelection(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function"
  );
}

/** `true` si el navegador soporta asignar dispositivo de salida
 *  a un AudioContext (sinkId en el constructor). Soporte más
 *  reciente y limitado; lo usamos como complemento de setSinkId. */
export function supportsAudioContextSinkId(): boolean {
  const AC =
    typeof window !== "undefined"
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!AC) return false;
  const proto = AC.prototype as { setSinkId?: unknown };
  return typeof proto.setSinkId === "function";
}

/* ---------------- Persistencia ---------------- */

export function getSavedInputId(): string | null {
  try {
    return localStorage.getItem(LS_INPUT) || null;
  } catch {
    return null;
  }
}

export function getSavedOutputId(): string | null {
  try {
    return localStorage.getItem(LS_OUTPUT) || null;
  } catch {
    return null;
  }
}

export function saveInputId(id: string | null) {
  try {
    if (id) localStorage.setItem(LS_INPUT, id);
    else localStorage.removeItem(LS_INPUT);
  } catch {
    /* sin persistencia */
  }
}

export function saveOutputId(id: string | null) {
  try {
    if (id) localStorage.setItem(LS_OUTPUT, id);
    else localStorage.removeItem(LS_OUTPUT);
  } catch {
    /* sin persistencia */
  }
}

/* ---------------- Enumeración ---------------- */

/** Etiqueta legible cuando el navegador aún no autoriza la
 *  enumeración detallada (caso típico antes de getUserMedia). */
function friendlyLabel(d: MediaDeviceInfo, idx: number, kind: "input" | "output"): string {
  // Si el navegador nos da un label útil lo usamos.
  if (d.label) return d.label;
  const isDefault = idx === 0;
  return kind === "input"
    ? isDefault
      ? "Micrófono predeterminado"
      : `Micrófono ${idx + 1}`
    : isDefault
      ? "Salida predeterminada"
      : `Salida ${idx + 1}`;
}

/** Devuelve la lista de dispositivos visibles para el navegador. */
export async function listDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [] };
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  const rawInputs = all.filter((d) => d.kind === "audioinput");
  const rawOutputs = all.filter((d) => d.kind === "audiooutput");
  return {
    inputs: rawInputs.map((d, i) => ({
      deviceId: d.deviceId,
      label: friendlyLabel(d, i, "input"),
      kind: d.kind,
    })),
    outputs: rawOutputs.map((d, i) => ({
      deviceId: d.deviceId,
      label: friendlyLabel(d, i, "output"),
      kind: d.kind,
    })),
  };
}

/* ---------------- Suscripción a cambios ---------------- */

type Listener = (devices: { inputs: AudioDevice[]; outputs: AudioDevice[] }) => void;
const listeners = new Set<Listener>();

/** Emite un cambio a todos los listeners registrados. */
function emit(devices: { inputs: AudioDevice[]; outputs: AudioDevice[] }) {
  listeners.forEach((fn) => {
    try {
      fn(devices);
    } catch {
      /* listener roto — no afecta a los demás */
    }
  });
}

/** Inicia la observación y dispara una enumeración inicial. */
export async function startDeviceWatcher(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
  if (!navigator.mediaDevices) return { inputs: [], outputs: [] };
  if (typeof navigator.mediaDevices.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", refresh);
  } else if (typeof navigator.mediaDevices.addEventListener !== "function") {
    // Safari viejo, fallback no soportado: no hacemos nada.
  }
  return refresh();
}

async function refresh(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
  const devices = await listDevices();
  emit(devices);
  return devices;
}

/** Registra un listener. Devuelve función para des-suscribirse. */
export function onDevicesChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
