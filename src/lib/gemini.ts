import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.6-flash";

/* ============================================================
   PDFs de la cátedra
   ------------------------------------------------------------
   Los PDFs viven en /public y se sirven en la raíz. Los
   subimos a la Files API de Gemini una vez y los reusamos
   durante su ventana de 48 h. Cacheamos el `name`/`uri` y la
   `expirationTime` en localStorage para no resubir en cada
   consulta.
   ============================================================ */

export interface PdfSource {
  /** Nombre que ve el modelo en el system prompt. */
  label: string;
  /** URL relativa desde la raíz (servida por Vite desde /public). */
  url: string;
  /** MIME type del archivo. */
  mimeType: string;
  /** Nombre único para cachear en localStorage. */
  cacheKey: string;
}

export const PDF_SOURCES: PdfSource[] = [
  {
    label: "01.BC_1P.pdf",
    url: "/01.BC_1P.pdf",
    mimeType: "application/pdf",
    cacheKey: "pdf-01-bc-1p",
  },
  {
    label: "02.BC_2P.pdf",
    url: "/02.BC_2P.pdf",
    mimeType: "application/pdf",
    cacheKey: "pdf-02-bc-2p",
  },
];

interface CachedPdf {
  name: string;
  uri: string;
  expirationTime: string; // ISO 8601
  uploadedAt: number;
}

const PDF_CACHE_PREFIX = "gem-pdf:";

function readCache(): Record<string, CachedPdf> {
  try {
    const raw = localStorage.getItem("gem-pdfs-cache");
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CachedPdf>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, CachedPdf>): void {
  try {
    localStorage.setItem("gem-pdfs-cache", JSON.stringify(cache));
  } catch {
    /* sin persistencia */
  }
}

function isExpired(c: CachedPdf): boolean {
  if (!c?.expirationTime) return true;
  const t = Date.parse(c.expirationTime);
  if (Number.isNaN(t)) return true;
  // Margen de 10 min antes de la expiración real para evitar 404
  // justo en el medio de una consulta.
  return Date.now() > t - 10 * 60 * 1000;
}

/** Sube un PDF a la Files API de Gemini. */
async function uploadPdf(
  ai: GoogleGenAI,
  src: PdfSource
): Promise<CachedPdf> {
  const resp = await fetch(src.url);
  if (!resp.ok) {
    throw new Error(`No se pudo descargar ${src.url} (HTTP ${resp.status}).`);
  }
  const blob = await resp.blob();
  // El SDK acepta Blob/File. Le pasamos config con mimeType y
  // displayName para que el archivo sea fácil de identificar en la
  // consola de Google AI Studio si hace falta debuggear.
  // Tipamos como `any` para no atarnos a la forma exacta de la config
  // del SDK, que varía entre versiones.
  const uploaded = (await (ai as unknown as {
    files: {
      upload: (args: { file: Blob; config: { mimeType: string; displayName: string } }) => Promise<{
        name?: string;
        uri?: string;
        expirationTime?: string;
      }>;
    };
  }).files.upload({
    file: blob,
    config: { mimeType: src.mimeType, displayName: src.label },
  })) as { name?: string; uri?: string; expirationTime?: string };

  if (!uploaded.name || !uploaded.uri) {
    throw new Error(`Gemini no devolvió uri/name al subir ${src.label}.`);
  }
  return {
    name: uploaded.name,
    uri: uploaded.uri,
    expirationTime: uploaded.expirationTime ?? new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    uploadedAt: Date.now(),
  };
}

/** Verifica si un archivo cacheado sigue activo en Gemini. */
async function isFileAlive(
  ai: GoogleGenAI,
  name: string
): Promise<boolean> {
  try {
    const f = (await (ai as unknown as {
      files: { get: (args: { name: string }) => Promise<{ state?: string }> };
    }).files.get({ name })) as { state?: string };
    return f?.state === "ACTIVE";
  } catch {
    // 404 u otro error -> el archivo ya no existe.
    return false;
  }
}

export interface PdfPart {
  fileData: { fileUri: string; mimeType: string };
}

/**
 * Garantiza que los PDFs de la cátedra están subidos a la Files API
 * de Gemini y devuelve los `fileData` para adjuntar en cada request.
 * Cachea en localStorage para no resubir en cada consulta.
 *
 * Si la subida falla, loguea y devuelve un array vacío: el sistema
 * sigue funcionando (sin PDFs), el prompt menciona los nombres
 * como referencia teórica. El error NO se propaga, para no romper
 * el flujo principal de la consulta.
 */
export async function ensurePdfs(ai: GoogleGenAI): Promise<PdfPart[]> {
  const cache = readCache();
  const out: PdfPart[] = [];
  const next: Record<string, CachedPdf> = { ...cache };

  for (const src of PDF_SOURCES) {
    let cached = cache[src.cacheKey];
    let alive = false;
    if (cached && !isExpired(cached)) {
      alive = await isFileAlive(ai, cached.name);
    }
    if (!alive) {
      try {
        // eslint-disable-next-line no-console
        console.info(`[gem] Subiendo ${src.label} a Files API…`);
        cached = await uploadPdf(ai, src);
        next[src.cacheKey] = cached;
        // eslint-disable-next-line no-console
        console.info(`[gem] ${src.label} listo como ${cached.name} (expira ${cached.expirationTime})`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[gem] No se pudo subir ${src.label}:`, err);
        delete next[src.cacheKey];
        continue;
      }
    }
    if (cached) {
      out.push({
        fileData: { fileUri: cached.uri, mimeType: src.mimeType },
      });
    }
  }

  writeCache(next);
  return out;
}


/**
 * Prompt del sistema — Tutor IA experto en Biología del Comportamiento
 * (Cátedra Dr. Rubén N. Muzio, Psicología UBA).
 * IMPORTANTE: el prompt usa markdown para legibilidad humana en el panel
 * de configuración. El TTS puede leer literal los asteriscos; si molesta,
 * se filtran antes de enviar a speechSynthesis.
 */
export const SYSTEM_PROMPT = `Rol: Tutor IA experto en Biología del Comportamiento (Cátedra Dr. Rubén N. Muzio, Psicología UBA).
Objetivo: Resolver preguntas Multiple Choice, crear simulacros y aclarar dudas teóricas de forma directa y fundamentada, utilizando ÚNICA Y EXCLUSIVAMENTE los documentos provistos: "01.BC_1P.pdf" (Primer parcial) y "02.BC_2P.pdf" (Segundo parcial).
CONTEXTO DE EVALUACIÓN Y TEMARIO
- Exámenes exigentes de 30 preguntas Multiple Choice (hasta 5 opciones, incluyendo "Todas/Ninguna") o Verdadero/Falso con trampas conceptuales.
- Ejes de evaluación: Causas próximas (fisiología, ontogenia) y últimas (función adaptativa, filogenia / Tinbergen-Mayr).
- Temas: 1. Niveles de causalidad/Evolución; 2. Genética cuantitativa; 3. Epigénesis; 4. Lenguaje; 5. Motivación e ingesta; 6. Neurobiología comparada/Agresión; 7. Estrés/PNIE; 8. Bases neurales (Esquizofrenia/Alzheimer); 9. Toma de decisiones (Heurísticos); 10. Aprendizaje y memoria.
TAREAS PRINCIPALES
1. Resolver preguntas: Aplica el Formato de Respuesta Obligatorio.
2. Crear simulacros: A pedido, genera exámenes de 30 preguntas (o menos) con la dificultad y estilo exacto de la cátedra, incluyendo la clave de corrección.
3. Explicar teoría: Resuelve dudas sobre gráficos, fórmulas y conceptos complejos haciendo referencia explícita a los PDFs.
FORMATO DE RESPUESTA OBLIGATORIO (Para resolución de preguntas)
Responde estricta y directamente con esta estructura, sin introducciones, confirmaciones ni saludos:
Opción correcta: [Letra y enunciado]
¿Por qué es la correcta?: [Explicación conceptual de 2 o 3 líneas máximo]
¿Por qué son incorrectas las demás?:
- Opción [X]: [Motivo en 1 línea]
- Opción [Y]: [Motivo en 1 línea]
- Opción [Z]: [Motivo en 1 línea]`;

/**
 * Lee la API key desde la variable de entorno de Vite.
 * Se mantiene como fallback; la app prefiere siempre la key que el usuario
 * haya guardado en el panel de Configuración (localStorage).
 */
export const GEMINI_API_KEY: string = (
  (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env?.VITE_GEMINI_API_KEY ?? ""
).trim();


export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "audio/webm";
}

/**
 * Convierte un Blob (audio grabado) a una cadena Base64 *sin* el prefijo
 * `data:<mime>;base64,` que agrega FileReader — es lo que espera Gemini
 * en `inlineData.data`.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(new Error("No se pudo codificar el audio a Base64."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Error de Gemini con un campo `detail` para que la UI pueda mostrar
 * el mensaje amigable por un lado y el detalle técnico en un
 * <details> colapsable. Sin esto, terminábamos mostrando JSON crudo
 * de Google en la pantalla del usuario.
 */
export class GeminiError extends Error {
  readonly detail?: string;
  readonly code?: number | string;
  readonly status?: string;
  constructor(message: string, opts: { detail?: string; code?: number | string; status?: string } = {}) {
    super(message);
    this.name = "GeminiError";
    this.detail = opts.detail;
    this.code = opts.code;
    this.status = opts.status;
  }
}

/**
 * Intenta parsear un string como JSON de error de Google y devolver
 * el `message` y metadatos que contiene. Devuelve `null` si el
 * string no es JSON parseable con forma de error de Google.
 */
function parseGoogleErrorJson(raw: string): { message: string; code?: number; status?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes("\"error\"")) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string; code?: number; status?: string };
    };
    const msg = parsed?.error?.message;
    if (typeof msg !== "string" || !msg) return null;
    return { message: msg, code: parsed.error?.code, status: parsed.error?.status };
  } catch {
    return null;
  }
}

/**
 * Extrae un mensaje legible y, por separado, un detalle técnico
 * de un error arbitrario (incluido el del SDK). El detalle puede
 * incluir el `message` original de Google, el código HTTP, etc.,
 * y la UI decide si lo muestra o no.
 */
function describeError(err: unknown): { message: string; detail: string; code?: number | string; status?: string } {
  const fallback = { message: "Error desconocido al hablar con Gemini.", detail: "" };
  if (typeof err === "string") {
    const parsed = parseGoogleErrorJson(err);
    if (parsed) {
      return {
        message: parsed.message,
        detail: parsed.code ? `[${parsed.code}] ${parsed.message}` : parsed.message,
        code: parsed.code,
        status: parsed.status,
      };
    }
    return { message: err, detail: err };
  }
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      status?: number | string;
      code?: number | string;
      error?: { message?: string; code?: number | string; status?: string };
    };

    // 1) El SDK a veces mete el JSON de Google como string en `message`.
    if (typeof e.message === "string") {
      const parsed = parseGoogleErrorJson(e.message);
      if (parsed) {
        return {
          message: parsed.message,
          detail: parsed.code ? `[${parsed.code}] ${parsed.message}` : parsed.message,
          code: parsed.code,
          status: parsed.status,
        };
      }
    }

    // 2) Forma estructurada: { error: { message, code, status } }
    if (e.error?.message) {
      const code = e.error.code ?? e.status ?? e.code;
      const status = e.error.status;
      const detailMsg = code ? `[${code}] ${e.error.message}` : e.error.message;
      return { message: e.error.message, detail: detailMsg, code, status };
    }

    // 3) Fallback: el `message` plano.
    if (e.message) {
      return { message: e.message, detail: e.message };
    }
    return fallback;
  }
  return fallback;
}

/**
 * Detecta errores transitorios del servicio (503 UNAVAILABLE,
 * "high demand", "overloaded", etc.). En esos casos, reintentamos
 * con backoff antes de mostrar el error al usuario.
 */
function isTransientError(err: unknown): boolean {
  const { message, status, code } = describeError(err);
  const lower = `${message} ${status ?? ""} ${code ?? ""}`.toLowerCase();
  return (
    lower.includes("503") ||
    lower.includes("unavailable") ||
    lower.includes("high demand") ||
    lower.includes("overloaded") ||
    lower.includes("try again later") ||
    lower.includes("resource_exhausted")
  );
}

/**
 * Envía el audio a Gemini usando el SDK oficial `@google/genai`.
 *
 * Usamos el SDK (en lugar de `fetch` directo) porque Google dejó de aceptar
 * las nuevas Auth Keys con prefijo `AQ.` en el endpoint REST crudo para
 * algunas cuentas — el SDK negocia la auth correctamente y además nos da
 * errores tipados con el mensaje real de Google.
 *
 * Manejo de errores:
 *  - Errores transitorios (503/UNAVAILABLE/"high demand"): reintenta una
 *    vez con 4 s de espera. Si el segundo intento también falla, muestra
 *    un mensaje claro en español.
 *  - API key inválida / 401/403: mensaje específico, sin reintento.
 *  - Cuota agotada / 429: mensaje específico, sin reintento.
 *  - Errores de red: mensaje específico, sin reintento.
 */
export async function askGemini(base64Audio: string, mimeType: string, apiKey: string): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }

  const ai = new GoogleGenAI({ apiKey: cleanKey });

  // Subimos (si hace falta) los PDFs de la cátedra y los adjuntamos
  // al request. Si la subida falla, seguimos sin PDFs: el system prompt
  // ya los menciona como referencia teórica.
  const pdfParts = await ensurePdfs(ai);

  const parts: Array<
    | { inlineData: { mimeType: string; data: string } }
    | { fileData: { fileUri: string; mimeType: string } }
    | { text: string }
  > = [];

  // Primero los PDFs (contexto del documento), después el audio y la
  // consigna textual. Gemini acepta cualquier orden, pero poner el
  // contexto documental primero suele dar mejores resultados.
  for (const p of pdfParts) parts.push(p);
  parts.push({ inlineData: { mimeType, data: base64Audio } });
  parts.push({ text: "Escucha el audio adjunto y, basándote en los documentos de la cátedra adjuntos, responde según las instrucciones del sistema." });

  const contents = [{ parts }];
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    // Bajamos el techo: las respuestas de multiple choice rara vez
    // superan los 600 tokens, y un techo más bajo = respuesta más
    // rápida (menos que generar).
    maxOutputTokens: 1024,
    // Thinking LOW reduce la latencia drásticamente (sin esto, el
    // modelo "piensa" mucho antes de empezar a generar texto y
    // una respuesta puede tardar varios minutos).
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    // Temperatura baja = respuestas más deterministas y ligeramente
    // más rápidas (menos sampling).
    temperature: 0.3,
  };

  const MAX_ATTEMPTS = 3;
  // Backoff en ms: 1er reintento a los 4 s, 2do a los 8 s.
  const BACKOFF_MS = [4000, 8000];
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config,
      });
      const text = (response?.text ?? "").trim();
      if (!text) {
        throw new Error("Gemini no devolvió texto. Intenta grabar la pregunta con más claridad.");
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isTransientError(err)) {
        // Backoff antes del reintento. Mientras tanto la UI muestra
        // "Procesando con Gemini…" (estado processing) — el usuario
        // puede pensar que la app colgó, pero es el comportamiento
        // esperado: reintento silencioso con espera.
        const wait = BACKOFF_MS[attempt - 1] ?? 4000;
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      break;
    }
  }

  // Si llegamos acá, falló definitivamente. Mapeo a un mensaje
  // amigable en español, sin JSON crudo en la UI. El detalle técnico
  // va aparte (GeminiError.detail) y la UI lo muestra en un <details>
  // colapsable.
  const { message, detail, code, status } = describeError(lastErr);
  const lower = `${message} ${detail}`.toLowerCase();

  if (
    lower.includes("api key") ||
    lower.includes("auth") ||
    lower.includes("credential") ||
    lower.includes("permission") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    throw new GeminiError("Gemini rechazó tu API Key. Verificá que esté bien copiada y que la key tenga acceso a este modelo.", {
      detail,
      code,
      status,
    });
  }
  if (lower.includes("quota") || lower.includes("429") || lower.includes("rate") || lower.includes("resource_exhausted")) {
    throw new GeminiError("Llegaste al límite de uso de Gemini (cuota o rate-limit). Esperá unos minutos o revisá tu plan en Google AI Studio.", {
      detail,
      code,
      status,
    });
  }
  if (isTransientError(lastErr)) {
    throw new GeminiError(
      "El servicio de Gemini está saturado ahora mismo. Esperá uno o dos minutos y volvé a intentar.",
      { detail, code, status }
    );
  }
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("econn") || lower.includes("timeout")) {
    throw new GeminiError("No se pudo contactar a Gemini. Revisá tu conexión a internet y reintentá.", { detail });
  }
  throw new GeminiError("Gemini rechazó la solicitud. Probá grabar de nuevo la pregunta.", { detail, code, status });
}
