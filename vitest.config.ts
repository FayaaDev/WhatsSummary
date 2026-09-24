import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    // Modules import handlers directly; tests do not require browser assets or an API entrypoint.
    miniflare: {
      compatibilityDate: "2026-08-15",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
    },
  })],
  test: { include: ["test/**/*.test.ts"] },
});
