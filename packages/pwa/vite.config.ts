import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const HUB_HTTP = (process.env.VITE_HUB_URL ?? "ws://localhost:17745")
  .replace(/^ws(s?):\/\//, "http$1://");

const proxy = {
  "/daemons": HUB_HTTP,
  "/devices": HUB_HTTP,
  "/push": HUB_HTTP,
  "/pair": HUB_HTTP,
  "/auth": HUB_HTTP,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 15173, proxy },
  preview: { proxy },
});
