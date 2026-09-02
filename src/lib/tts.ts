/**
 * Limpia el texto que va a ser leído por `speechSynthesis`.
 *
 * El modelo de Gemini a veces devuelve markdown (**negrita**, *cursiva*,
 * # encabezados, listas con `-`, links `[texto](url)`, etc.) y el motor
 * TTS del navegador lo lee literal — "asterisco asterisco opción
 * correcta asterisco asterisco" — lo que suena horrible.
 *
 * Esta función quita la sintaxis markdown pero conserva el contenido
 * legible, y normaliza separadores para que la prosodia no se rompa.
 *
 * Pensada para una pasada rápida por texto corto (≤ unos pocos KB).
 */
export function cleanForTTS(input: string): string {
  if (!input) return "";

  let t = input;

  // 1) Links: [texto](url) -> texto
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // 2) Imágenes: ![alt](url) -> alt (suele no aparecer en respuestas, pero por si acaso)
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");

  // 3) Bloques de código multilínea ```...``` -> contenido sin fences
  t = t.replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1");

  // 4) Código inline `code` -> code
  t = t.replace(/`([^`]+)`/g, "$1");

  // 5) Bold/italic: primero los triples (***...***), luego dobles (**...**)
  //    y dobles con underscore (__...__), después simples (*...*, _..._)
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1$2");

  // 6) Tachado ~~texto~~ -> texto
  t = t.replace(/~~([^~]+)~~/g, "$1");

  // 7) Encabezados: #, ##, ### al inicio de línea -> solo el texto,
  //    con un punto para que el TTS haga una micro-pausa.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");

  // 8) Blockquote > ...
  t = t.replace(/^\s{0,3}>\s?/gm, "");

  // 9) Listas: "- item", "* item", "+ item" al inicio de línea -> "item"
  //    Listas enumeradas "1. item" -> "item" (el número no aporta al TTS,
  //    y leer "uno punto item" suena mal).
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, "");
  t = t.replace(/^\s{0,3}\d+\.\s+/gm, "");

  // 10) Reglas horizontales ---, ***, ___
  t = t.replace(/^\s{0,3}[-*_]{3,}\s*$/gm, "");

  // 11) Citas tipográficas (no aportan al TTS) — dejamos comillas rectas,
  //     que el motor las maneja mejor que las curvas " " ' '.
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  // 12) Em-dash y en-dash como pausas naturales (los dejamos, el TTS los
  //     lee con una pausa corta).

  // 13) Normalizar espacios y saltos de línea:
  //     - cualquier \n se convierte en espacio (después el split por
  //       '[.!?]' trocea por oraciones, no por líneas sueltas — el TTS
  //       lee corrido, sin pausas artificiales entre cada ítem de una
  //       lista markdown).
  //     - múltiples espacios/tabs -> un solo espacio.
  t = t.replace(/\r\n/g, "\n");
  t = t.replace(/\s*\n\s*/g, " ");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.trim();

  return t;
}
