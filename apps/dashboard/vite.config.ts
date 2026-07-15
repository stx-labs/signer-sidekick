import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3998",
      "/health": "http://127.0.0.1:3998",
      "/metrics": "http://127.0.0.1:3998",
    },
  },
});
