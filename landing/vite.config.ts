import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages project sites live under `/free-llm-router/`, so `base` matches.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "/free-llm-router/"
});
