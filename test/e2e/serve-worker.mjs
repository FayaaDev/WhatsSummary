import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, createWriteStream, rmSync } from "node:fs";

// Dedicated local state: never reset a developer's normal Wrangler database.
const state = ".wrangler/e2e";
mkdirSync(state, { recursive: true });
// Reapply both migrations from scratch, only inside the fixed test runtime directory.
rmSync(`${state}/v3`, { recursive: true, force: true });
const config = ["--config", "test/e2e/wrangler.jsonc"];
const storage = ["--local", "--persist-to", state];
const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
const result = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", ...config, ...storage],
  { stdio: ["ignore", "inherit", "inherit"], env });
if (result.status !== 0) process.exit(result.status ?? 1);
const log = createWriteStream(`${state}/worker.log`, { flags: "w" });
const child = spawn("npx", ["wrangler", "dev", ...config, ...storage,
  "--ip", "127.0.0.1", "--port", "8788", "--inspector-port", "0", "--show-interactive-dev-session=false"],
  { env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
// Keep descendants in Playwright's process group so teardown also kills Wrangler/workerd.
child.on("exit", code => { log.end(); process.exitCode = code ?? 0; });
