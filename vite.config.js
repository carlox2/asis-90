import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Detecta el nombre del repo en runtime.
 *
 * - En GitHub Actions:  GITHUB_REPOSITORY = "owner/repo" → usa "repo".
 * - En build local:     si pasás VITE_REPO_NAME por env, lo usa.
 * - Si no hay nada:     cae a "asistente-gem" (default).
 *
 * Esto evita que la app rompa si el repo se llama distinto a "asistente-gem".
 */
function detectRepoName() {
  const fromGh = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (fromGh) return fromGh;
  const fromEnv = process.env.VITE_REPO_NAME;
  if (fromEnv) return fromEnv;
  return "asistente-gem";
}

const repo = detectRepoName();

export default defineConfig({
  base: `/${repo}/`,
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    hmr: {
      port: 3000,
    },
  },
});
