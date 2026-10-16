import { defineConfig } from "vite";
import patchwork from "@inkandswitch/patchwork/vite";
import { SUBDUCTION_PORT } from "../ports.ts";


export default defineConfig({
  plugins: [
    patchwork({
      title: "Patchwork (presence repro)",
      storagePrefix: "patchwork-presence-repro",
      syncServers: { subduction: `ws://127.0.0.1:${SUBDUCTION_PORT}`, classic: "ws://127.0.0.1:9" },
      icons: false,
      netlify: false,
      buildInfo: false,
      static: ["@inkandswitch/patchwork-pkg-base"],
    }),
  ],
});
