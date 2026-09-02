/* ============================================================
   OSCILOSCOPIO DE LA CONSOLA
   ------------------------------------------------------------
   · idle   → ondas senoidales ambientales (la consola "respira")
   · live   → forma de onda real del micrófono (AnalyserNode)
   · paused → congela el último fotograma y lo atenúa en ámbar
   ============================================================ */

import { useEffect, useRef } from "react";

export type WaveMode = "idle" | "live" | "paused";

interface Props {
  getAnalyser: () => AnalyserNode | null;
  mode: WaveMode;
}

export default function Waveform({ getAnalyser, mode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<WaveMode>(mode);
  modeRef.current = mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;

    let raf = 0;
    let frozen: Uint8Array | null = null; // último fotograma para la pausa

    const drawTrace = (arr: Uint8Array, w: number, h: number, color: string, width: number) => {
      g.beginPath();
      const step = w / arr.length;
      for (let i = 0; i < arr.length; i++) {
        const y = (arr[i] / 255) * h;
        if (i === 0) g.moveTo(0, y);
        else g.lineTo(i * step, y);
      }
      g.strokeStyle = color;
      g.lineWidth = width;
      g.stroke();
    };

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      // Línea media de referencia
      g.strokeStyle = "rgba(233,244,241,0.07)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
      g.stroke();

      const m = modeRef.current;

      if (m === "idle") {
        frozen = null;
        // Tres ondas lentas superpuestas: la consola en reposo
        const layers = [
          { amp: h * 0.16, speed: 0.00045, k: 0.012, color: "rgba(76,201,212,0.4)" },
          { amp: h * 0.1, speed: -0.0007, k: 0.02, color: "rgba(61,220,151,0.3)" },
          { amp: h * 0.06, speed: 0.0011, k: 0.032, color: "rgba(255,194,75,0.22)" },
        ];
        layers.forEach((L) => {
          g.beginPath();
          for (let x = 0; x <= w; x += 3) {
            const y =
              h / 2 +
              Math.sin(x * L.k + t * L.speed) * L.amp * Math.sin(t * 0.0003 + x * 0.004);
            if (x === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.strokeStyle = L.color;
          g.lineWidth = 1.6;
          g.stroke();
        });
        return;
      }

      const analyser = getAnalyser();
      if (m === "live" && analyser) {
        const buf = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buf);
        frozen = buf;
        // Halo suave + trazo principal en coral
        drawTrace(buf, w, h, "rgba(255,107,94,0.22)", 5);
        drawTrace(buf, w, h, "rgba(255,138,122,0.95)", 1.8);
      } else if (frozen) {
        // Pausa: fotograma congelado, atenuado en ámbar
        drawTrace(frozen, w, h, "rgba(255,194,75,0.4)", 1.6);
      } else {
        g.strokeStyle = "rgba(255,194,75,0.3)";
        g.beginPath();
        g.moveTo(0, h / 2);
        g.lineTo(w, h / 2);
        g.stroke();
      }
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [getAnalyser]);

  return <canvas ref={canvasRef} className="h-24 w-full sm:h-28" aria-label="Forma de onda del micrófono" />;
}
