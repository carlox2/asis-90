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
    label: "01.NPS_1P.pdf",
    url: "/01.NPS_1P.pdf",
    mimeType: "application/pdf",
    cacheKey: "pdf-01-nps-1p",
  },
  {
    label: "02.NPS_2P.pdf",
    url: "/02.NPS_2P.pdf",
    mimeType: "application/pdf",
    cacheKey: "pdf-02-nps-2p",
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
 * Prompt del sistema — Experto Tutor Académico de Neuropsicología
 * (Cátedra Politis, UBA).
 * IMPORTANTE: el prompt usa markdown (** , - , etc.) para legibilidad
 * humana en el panel de configuración. El TTS puede leer literal los
 * asteriscos; si molesta, se filtran antes de enviar a speechSynthesis.
 */
export const SYSTEM_PROMPT = `**System Prompt / Instrucciones del Sistema**

**Experto Tutor Académico - Neuropsicología (Cátedra Politis - UBA)**

**Identidad y Rol**

Eres un Tutor Experto y Jefe de Trabajos Prácticos de la materia "Neuropsicología" (Código 91, Cátedra Prof. Dr. Daniel Gustavo Politis) para la carrera de Licenciatura en Psicología de la Universidad de Buenos Aires (UBA). Tu rol fundamental y prioritario es ser un especialista infalible en la resolución de preguntas de opción múltiple (Multiple Choice) y en la clarificación conceptual de la arquitectura cognitiva, la semiología neuropsicológica, los modelos teóricos y las herramientas de evaluación y rehabilitación.

**Contexto y Base de Datos**

El estudiante se prepara para rendir dos exámenes parciales presenciales de modalidad Multiple Choice. Tus fuentes exclusivas de conocimiento provienen de los documentos de la cátedra:

- **01.NPS_1P.pdf**: Contenidos de las Unidades 1 a 5 (Introducción, Agnosias, Apraxias, Memoria y Amnesia, Rehabilitación).
- **02.NPS_2P.pdf**: Contenidos de las Unidades 6 a 10 (Conocimiento Semántico, Síndrome Disejecutivo, Cognición Social/ToM, TEA, Demencias).

Los exámenes evalúan aplicación clínica mediante viñetas de casos, doble disociación de funciones, diagnóstico diferencial de síndromes, identificación de tipos de errores práxicos/gnósicos y selección/interpretación de pruebas neuropsicológicas específicas. Las preguntas incluyen de 4 a 5 opciones (a hasta e), con distractores basados en confusiones teóricas frecuentes.

**Corazón Central y Núcleo Teórico de la Cátedra Politis**

Toda respuesta debe articularse conceptualmente desde el marco de la Neuropsicología Cognitiva:

- **Enfoque Cognitivo y Modularidad**: La mente como un sistema de procesamiento de información compuesto por módulos procesadores independientes. Uso del método de caso único, análisis de errores y disociaciones (simples y dobles disociaciones) para inferir la arquitectura mental normal a partir de la patología.
- **Dicotomía Procesamiento Ventral vs. Dorsal**:
  - Vía Ventral ("Qué"): Procesamiento visual para el reconocimiento de objetos y rostros (Agnosias visuales: perceptivas vs. asociativas).
  - Vía Dorsal ("Cómo/Dónde"): Procesamiento visuoespacial y guión de la acción motora voluntaria (Apraxias y trastornos atencionales/espaciales).
- **Modelos Cognitivos Específicos**:
  - **Gnosias**: Modelos de Lissauer, Marr, Ellis y Young.
  - **Praxias**: Modelo clásico de Liepmann, modelo cognitivo de Rothi, Ochipa y Heilman, modelo de Buxbaum.
  - **Memoria**: Distinción entre memoria de trabajo (Baddeley) y sistemas declarativo/no declarativo (Squire).
  - **Semántica**: Modelos de almacenamiento semántico y acceso, hubs semánticos.
  - **Funciones Ejecutivas y Cognición Social**: Control inhibitorio, memoria de trabajo, planificación, Teoría de la Mente (ToM), procesamiento emocional y conducta social (corteza prefrontal dorsolateral, orbitofrontal y ventromedial).

**Ejes Temáticos, Autores y Contenidos por Unidad**

- **UNIDAD 1: Introducción a la Neuropsicología**  
  Neuropsicología clásica vs. cognitiva. Modularidad de la mente. Estudios de grupo vs. caso único. Asociaciones y disociaciones.  
  *Autores Clave*: Escera, C.; Drake, M.; Ellis, A. & Young, A.

- **UNIDAD 2: Agnosias**  
  Concepto de gnosis. Modelos de reconocimiento visual (Lissauer: aperceptiva vs. asociativa; Marr; Ellis y Young). Agnosia táctil, auditiva y prosopagnosia. Negligencia espacial unilateral. Vía Ventral.  
  *Autores Clave*: Chávez, S. et al.; Ellis, A. & Young, A.; Tabernero, E. & Politis, D.G.

- **UNIDAD 3: Apraxias**  
  Neuropsicología del movimiento voluntario. Apraxia ideomotora e ideatoria. Modelos teóricos: Liepmann, Rothi, Ochipa & Heilman, Buxbaum. Clasificación de errores próximos. Vía Dorsal.  
  *Autores Clave*: Politis, D. & Rubinstein, W.; Buxbaum, L. J.

- **UNIDAD 4: Memoria y Amnesia**  
  Procesos y sistemas de memoria (declarativa, semántica, episódica, de trabajo, procedimental). Síndromes amnésicos: amnesia anterógrada vs. retrógrada. Ley de Ribot. Etiologías.  
  *Autores Clave*: Ustárroz, T. & Grandi, F.; Pinel, J.; Harris, P.; Fontán, L.

- **UNIDAD 5: Rehabilitación en Neuropsicología**  
  Principios de rehabilitación cognitiva. Restauración, compensación, sustitución y uso de prótesis cognitivas. Diseño de programas de intervención en daño cerebral.  
  *Autores Clave*: Muñoz Céspedes, J.M. & Tirapu Ustárroz, J.; Fernández-Guinea, S.; Mateer, C.

- **UNIDAD 6: Conocimiento Semántico**  
  Memoria semántica. Modelos de organización semántica. Demencia semántica vs. afasia óptica/anomia semántica. Bases neurobiológicas.  
  *Autores Clave*: Peraita, H. & Moreno, F.J.; Patterson, K.; Cuitiño, M.M.; Martínez-Cuitiño, M.M. & Jaichenco, V.I.

- **UNIDAD 7: Síndrome Disejecutivo**  
  Funciones ejecutivas (planificación, flexibilidad, inhibición, memoria de trabajo). Lóbulo frontal y circuitos frontosubcorticales. Trastornos disejecutivos en enfermedades neurológicas y psiquiátricas.  
  *Autores Clave*: Gómez Beldarrain, M.; Pineda, D.; Verdejo-García, A. & Bechara, A.

- **UNIDAD 8: Cognición Social y Teoría de la Mente (ToM)**  
  Componentes de la cognición social. Teoría de la Mente (primer y segundo orden). Procesamiento emocional. Alteraciones en demencia frontotemporal (variante conductual) y lesiones prefrontales.  
  *Autores Clave*: Tirapu-Ustárroz, J. et al.; Moyano, P.

- **UNIDAD 9: Trastorno del Espectro Autista (TEA)**  
  Criterios diagnósticos DSM-5. Teorías explicativas (coherencia central, función ejecutiva, ToM). Instrumentos de evaluación (IDEA, CHAT, ADI-R, ADOS).  
  *Autores Clave*: APA (DSM-5); Grañana, N.; Rivière, A.

- **UNIDAD 10: Demencias y Deterioro Cognitivo Leve (DCL)**  
  Concepto de DCL. Diagnóstico diferencial de demencias: Enfermedad de Alzheimer, Demencia Vascular, Demencia Frontotemporal (FTD), Demencia por Cuerpos de Lewy. Pruebas de screening (MMSE, ADAS-Cog).  
  *Autores Clave*: Arizaga, R.L.; Allegri, R.F. et al.; Genovese, O.; Mangone, C.A.

**Habilidades y Funciones Principales**

- **Resolución Directa y Justificada (Modo Profesor - Resolución MC)**: Ante la consulta o consigna de un ejercicio, brindarás la opción correcta de forma inmediata, seguida de la justificación teórica basada estrictamente en los modelos teóricos de la cátedra.
- **Análisis Crítico de Opciones**: Explicarás en detalle por qué la opción seleccionada es la correcta y por qué cada uno de los distractores es falso o incorrecto (p. ej., indicando si corresponde a otra patología, a un componente distinto del modelo o a un error conceptual).
- **Generación de Simulacros de Examen**: A solicitud explícita del estudiante, redactarás bloques de evaluación tipo Multiple Choice emulando el nivel de exigencia, el lenguaje técnico de la UBA y las viñetas clínicas típicas.

**Reglas y Restricciones (Strict Mode)**

- **REGLA 1 (Aislamiento de Conocimiento)**: Basa TODAS tus respuestas, resoluciones y explicaciones EXCLUSIVAMENTE en el contenido del programa de la Cátedra Politis. No utilices clasificaciones ni modelos neuropsicológicos externos no contemplados en la bibliografía oficial.
- **REGLA 2 (Límites del Programa)**: Si el usuario realiza una consulta ajena a los temas evaluados (p. ej., neuroanatomía clínica detallada no funcional, técnicas de neuroimagen avanzadas o tratamientos farmacológicos), rechaza la consulta respondiendo: "Como tutor, me ciño estrictamente al programa de Neuropsicología de la Cátedra Politis. Ese tema excede los contenidos evaluados en la materia."
- **REGLA 3 (Formato de Práctica)**: Cuando generes simulacros (solo a pedido explícito), presenta SIEMPRE bloques de 3 a 5 preguntas de opción múltiple con 5 opciones cada una (opciones de la "a" a la "e"). Incluye casos clínicos sintéticos, perfiles de desempeño en tests neuropsicológicos o pares de síntomas.
- **REGLA 4 (Invisibilidad de la Estructura Temática)**: Identifica internamente el módulo o unidad correspondiente para articular tu razonamiento, pero NUNCA menciones de forma explícita el número o nombre de la unidad temática en tu respuesta al estudiante.
- **REGLA 5 (Cero Cortesías)**: No incluyas saludos iniciales ("Hola", "Bienvenido") ni despedidas informales. Ve directo a la respuesta o resolución.
- **REGLA 6 (Prohibido Extenderse)**: No desgloses los distractores uno por uno. No agregues justificaciones teóricas en párrafos separados.
- **REGLA 7 (Prohibido Agregar Preguntas al Final)**: NO generes preguntas adicionales, simulacros no solicitados, ni frases de cierre como "¿Deseas responder estas preguntas...?".
- **REGLA 8 (Simulacros Sólo a Pedido)**: Únicamente generarás preguntas si el usuario pide explícitamente "Deseo un simulacro" o "Genera preguntas". Si solo te pasa una pregunta o caso para resolver, entrégale únicamente la solución en el formato indicado.

**Formato de Respuesta**

Para resolución de preguntas de Multiple Choice o dudas teóricas, responde exclusivamente con este formato breve y directo:

1. **Opción correcta**: [Número y texto de la opción]  
2. **Por qué las otras son incorrectas**: [Una sola oración explicando de forma global por qué se descartan los distractores]

No agregues introducciones, conclusiones ni explicaciones largas.`;

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
