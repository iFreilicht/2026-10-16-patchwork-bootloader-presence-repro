// A stock Patchwork site (only the base modules) on a stock subduction_cli, in Chromium. No tool
// code takes part: Alice and Bob use `window.repo` directly. Alice publishes an ephemeral message
// on a document every 100 ms; we count what Bob's tab receives.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { SITE_PORT, SUBDUCTION_PORT } from "./ports.ts";
const SITE = `http://localhost:${SITE_PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tcpOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
async function waitForPort(port: number) {
  for (let i = 0; i < 300 && !(await tcpOpen(port)); i++) await sleep(100);
}

type Win = Window & { repo: any; received?: number; pump?: ReturnType<typeof setInterval> };

/** A new browser profile with Patchwork booted. */
async function profile(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await bootTab(page);
  return page;
}
async function bootTab(page: Page) {
  await page.goto(SITE);
  await page.waitForFunction(() => (window as unknown as Win).repo !== undefined, undefined, { timeout: 120_000 });
  await page.waitForSelector(".threepane-sidebar", { timeout: 120_000 });
}

/** Alice creates a document and publishes on it every 100 ms. */
async function publish(alice: Page): Promise<string> {
  return alice.evaluate(() => {
    const w = window as unknown as Win;
    const handle = w.repo.create({ title: "presence repro" });
    w.pump = setInterval(() => handle.broadcast({ from: "alice", at: Date.now() }), 100);
    return handle.url as string;
  });
}

/** Opens the document in a tab and counts the messages from `from` that arrive on it. */
async function listen(page: Page, url: string, from = "alice"): Promise<void> {
  await page.evaluate(
    async ([url, from]) => {
      const w = window as unknown as Win;
      let handle;
      for (let i = 0; ; i++) {
        try {
          handle = await w.repo.find(url);
          break;
        } catch (error) {
          if (i === 40) throw error;
          await w.repo.removeFromCache(url.replace("automerge:", ""));
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      w.received = 0;
      handle.on("ephemeral-message", (e: { message: { from?: string } }) => e.message?.from === from && w.received!++);
    },
    [url, from],
  );
}

const received = (page: Page) => page.evaluate(() => (window as unknown as Win).received ?? 0);
async function during(page: Page, ms: number): Promise<number> {
  const before = await received(page);
  await sleep(ms);
  return (await received(page)) - before;
}

/** What a tool's module load does when its document isn't stored locally: the service worker hands the URL to Patchwork's automerge protocol handler worker. */
async function loadUnknownModule(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const specifier = "@automerge/automerge-repo";
    const { generateAutomergeUrl } = (await import(specifier)) as { generateAutomergeUrl(): string };
    await fetch(`/${encodeURIComponent(generateAutomergeUrl())}/index.js`).catch(() => undefined);
  });
}

async function scenario(browser: Browser, title: string, act: (bob: Page) => Promise<void>) {
  const alice = await profile(browser);
  const bob = await profile(browser);
  const url = await publish(alice);
  await listen(bob, url);
  await sleep(2000);
  const before = await during(bob, 3000);
  await act(bob);
  // The protocol handler worker evicts its documents 5 s after its last handoff.
  await sleep(6000);
  const after = await during(bob, 3000);
  const verdict = before > 0 && after === 0 ? "LOST" : after > 0 ? "ok" : "?";
  console.log(`${verdict.padEnd(4)} ${title}: Bob's tab got ${before} of Alice's messages in 3 s before, ${after} in 3 s, 6 s after`);
  await alice.context().close();
  await bob.context().close();
}

/** Serves the built site, as any static host would. */
function serveSite(): http.Server {
  const root = join(import.meta.dirname, "site", "dist");
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css", ".webmanifest": "application/manifest+json" };
  return http
    .createServer(async (request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? "/", SITE).pathname);
      const file = join(root, normalize(path.endsWith("/") ? `${path}index.html` : path));
      const found = file.startsWith(root) && (await stat(file).catch(() => undefined))?.isFile();
      if (!found) return void response.writeHead(404).end();
      response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
    })
    .listen(SITE_PORT, "localhost");
}

const children: ChildProcess[] = [];
const dataDir = await mkdtemp(join(tmpdir(), "subduction-repro-"));
try {
  children.push(spawn("subduction_cli", ["server", "--socket", `127.0.0.1:${SUBDUCTION_PORT}`, "--data-dir", dataDir, "--ephemeral-key"], { stdio: "ignore" }));
  const site = serveSite();
  await waitForPort(SUBDUCTION_PORT);
  const browser = await chromium.launch();

  await scenario(browser, "control: Bob does nothing", async () => {});
  await scenario(browser, "Bob's tab requests an automerge: URL that isn't stored locally", loadUnknownModule);

  // Bob's second tab (same profile, so the same Subduction key) publishes too.
  {
    const alice = await profile(browser);
    const bob = await profile(browser);
    const url = await publish(alice);
    const bob2 = await bob.context().newPage();
    await bootTab(bob2);
    await listen(bob, url, "bob2");
    await listen(bob2, url);
    await bob2.evaluate(async (url) => {
      const w = window as unknown as Win;
      const handle = await w.repo.find(url);
      w.pump = setInterval(() => handle.broadcast({ from: "bob2" }), 100);
    }, url);
    await sleep(2000);
    console.log(`     Bob's second tab publishes: Bob's first tab got ${await during(bob, 3000)} of its messages in 3 s; Alice's tab is not counted`);
    await alice.context().close();
    await bob.context().close();
  }
  await browser.close();
  site.close();
} finally {
  for (const child of children) child.kill();
  await rm(dataDir, { recursive: true, force: true });
}
