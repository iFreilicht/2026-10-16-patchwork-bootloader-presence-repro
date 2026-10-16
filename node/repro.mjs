// Several automerge-repo Repos that sign as one Subduction peer, as Patchwork's tabs and its
// automerge protocol handler worker do (patchwork-bootloader's signer.ts). Plain automerge-repo
// 2.6.0-subduction.48 with Patchwork's patch, a stock subduction_cli; no Patchwork, no tools.
//
// Alice publishes an ephemeral message on a document every 100 ms. "page" is subscribed to it.
// In each scenario a second Repo, "other", does what a Patchwork worker or tab does, and we count
// what page receives before and after. Every scenario runs twice: with "other" signing as the
// same peer as page (Patchwork), and with a key of its own (control).
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo, initSubduction } from "@automerge/automerge-repo";
import { MemorySigner } from "@automerge/automerge-subduction";

await initSubduction();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const tcpOpen = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

const port = await freePort();
const dataDir = await mkdtemp(join(tmpdir(), "subduction-repro-"));
const server = spawn("subduction_cli", ["server", "--socket", `127.0.0.1:${port}`, "--data-dir", dataDir, "--ephemeral-key"], { stdio: "ignore" });
while (!(await tcpOpen(port))) await sleep(100);
const endpoint = `ws://127.0.0.1:${port}`;

const seed = () => crypto.getRandomValues(new Uint8Array(32));
const repos = [];
const node = (name, key) => {
  const repo = new Repo({ peerId: name, signer: MemorySigner.fromBytes(key), subductionWebsocketEndpoints: [endpoint] });
  repos.push(repo);
  return repo;
};

/** Finds a document another Repo has just created, which may not have reached the server yet. */
const find = async (repo, url) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await repo.find(url);
    } catch (error) {
      if (attempt === 20) throw error;
      await repo.removeFromCache(url.replace("automerge:", ""));
      await sleep(250);
    }
  }
};

/** Counts the ephemeral messages a handle receives. */
const counter = (handle) => {
  const c = { n: 0 };
  handle.on("ephemeral-message", () => c.n++);
  return c;
};
/** How many messages `c` gets in `ms`. */
const during = async (c, ms) => {
  const before = c.n;
  await sleep(ms);
  return c.n - before;
};

async function scenario(title, sharedKey, act) {
  const alice = node("alice", seed());
  const pageKey = seed();
  const page = node("page", pageKey);
  const doc = alice.create({ title });
  const pageHandle = await find(page, doc.url);
  const received = counter(pageHandle);
  const pump = setInterval(() => doc.broadcast({ from: "alice", at: Date.now() }), 100);
  await sleep(1500);
  const before = await during(received, 2000);
  const other = node("other", sharedKey ? pageKey : seed());
  const note = await act({ other, doc, page, pageHandle });
  await sleep(1000);
  const after = await during(received, 2000);
  clearInterval(pump);
  const verdict = before > 0 && after === 0 ? "LOST" : after > 0 ? "ok" : "?";
  console.log(`${verdict.padEnd(4)} ${title} — ${sharedKey ? "same key as page (Patchwork)" : "own key (control)"}: page got ${before} msgs in 2 s before, ${after} in 2 s after${note ? ` (${note})` : ""}`);
}

const scenarios = [
  [
    // The protocol handler worker: it connects when a handoff needs the network, receives the
    // page's topics (the relay fans out to every connection of a subscribed peer), and evicts
    // its documents 5 s after the last handoff (repo.removeFromCache).
    "another node receives the topic, then evicts the document",
    async ({ other, doc }) => {
      await sleep(2500);
      const loaded = doc.documentId in other.handles;
      await other.removeFromCache(doc.documentId);
      return `the other node had loaded the document from the relayed messages: ${loaded}`;
    },
  ],
  [
    // A second tab of the same profile closing the document.
    "another node opens the document, then removes it from its cache",
    async ({ other, doc }) => {
      await find(other, doc.url);
      await sleep(1500);
      await other.removeFromCache(doc.documentId);
    },
  ],
  [
    // A second tab of the same profile closing.
    "another node opens the document, then shuts down",
    async ({ other, doc }) => {
      await find(other, doc.url);
      await sleep(1500);
      await other.shutdown();
    },
  ],
];

for (const [title, act] of scenarios) {
  for (const shared of [true, false]) await scenario(title, shared, act);
}

// A second tab of the same profile publishing: does page receive it?
{
  const alice = node("alice", seed());
  const pageKey = seed();
  const page = node("page", pageKey);
  for (const shared of [true, false]) {
    const doc = alice.create({ title: "publisher" });
    const pageHandle = await find(page, doc.url);
    const other = node("other", shared ? pageKey : seed());
    const otherHandle = await find(other, doc.url);
    await sleep(1500);
    const received = counter(pageHandle);
    const pump = setInterval(() => otherHandle.broadcast({ from: "other" }), 100);
    const n = await during(received, 2000);
    clearInterval(pump);
    console.log(`${(n === 0 ? "LOST" : "ok").padEnd(4)} another node publishes on the document — ${shared ? "same key as page (Patchwork)" : "own key (control)"}: page got ${n} msgs in 2 s`);
  }
}

await Promise.allSettled(repos.map((r) => r.shutdown()));
server.kill();
await rm(dataDir, { recursive: true, force: true });
process.exit(0);
