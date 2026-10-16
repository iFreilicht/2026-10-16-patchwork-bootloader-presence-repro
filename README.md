# Patchwork contexts sharing one Subduction identity lose each other's ephemeral messages

Every context of a Patchwork origin (each tab and the automerge protocol handler worker) signs as the same Subduction peer ([`signer.ts`](https://github.com/inkandswitch/patchwork-system/blob/bd12be7c10d6145cab0888f025c09b2f291612a7/core/bootloader/src/signer.ts): "each tab and the automerge protocol handler worker sign as the same peer"). The Subduction server keeps ephemeral subscriptions per peer (`ephemeral_subscriptions: Map<Topic, Set<PeerId>>`, [design/ephemeral.md](https://github.com/inkandswitch/subduction/blob/f0af1aab5f2fd44e5b224c22fc8b62660d50bc01/design/ephemeral.md#subscription-model)). So one context's `Unsubscribe` removes the subscription of all contexts, and the relay never sends a context's messages to its siblings.

In Patchwork this shows up as a tab that stops **receiving** presence messages (cursors, selections) about 5 s after the protocol handler worker fetched a document from the sync server, e.g. a tool module that isn't stored locally. The tab still **sends** presence messages just fine, and document sync is also unaffected, only **receiving** presence messages is broken.

This repo reproduces this issue in two independent parts, each with its own dependencies:

- [`node/`](node/repro.mjs): the mechanism with plain automerge-repo `Repo`s, with [Patchwork's patch of automerge-repo](node/patches/@automerge__automerge-repo@2.6.0-subduction.48.patch) (identical to the one `@inkandswitch/patchwork` 0.8.4 ships), and a control with separate keys.
- [`browser/`](browser/repro.ts): a stock Patchwork site (`@inkandswitch/patchwork` 0.8.4, base modules of `@inkandswitch/patchwork-pkg-base` 0.0.72, no other tools) in Chromium. Alice and Bob only use `window.repo`.

Both run against a stock `subduction_cli` (0.19.0, [subduction](https://github.com/inkandswitch/subduction) at `f0af1aab`).

## Run

```sh
nix develop          # node, pnpm, subduction_cli, Playwright's browsers
cd node && pnpm install && pnpm repro
cd ../browser && pnpm install && pnpm repro
```

## Results

`node/`: Alice publishes on a document every 100 ms; "page" is subscribed. A second `Repo`, "other", acts like Patchwork's worker or another tab, signing either with page's key or with its own:

```
LOST another node receives the topic, then evicts the document — same key as page (Patchwork): page got 20 msgs in 2 s before, 0 in 2 s after (the other node had loaded the document from the relayed messages: true)
ok   another node receives the topic, then evicts the document — own key (control): page got 20 msgs in 2 s before, 19 in 2 s after (the other node had loaded the document from the relayed messages: false)
LOST another node opens the document, then removes it from its cache — same key as page (Patchwork): page got 20 msgs in 2 s before, 0 in 2 s after
ok   another node opens the document, then removes it from its cache — own key (control): page got 20 msgs in 2 s before, 20 in 2 s after
ok   another node opens the document, then shuts down — same key as page (Patchwork): page got 20 msgs in 2 s before, 20 in 2 s after
ok   another node opens the document, then shuts down — own key (control): page got 20 msgs in 2 s before, 20 in 2 s after
LOST another node publishes on the document — same key as page (Patchwork): page got 0 msgs in 2 s
ok   another node publishes on the document — own key (control): page got 19 msgs in 2 s
```

`browser/`: Bob's tab requests an `automerge:` URL that no one has, as loading an unavailable tool module does. The service worker hands it to the protocol handler worker, which connects to the sync server to look for it:

```
ok   control: Bob does nothing: Bob's tab got 30 of Alice's messages in 3 s before, 30 in 3 s, 6 s after
LOST Bob's tab requests an automerge: URL that isn't stored locally: Bob's tab got 30 of Alice's messages in 3 s before, 0 in 3 s, 6 s after
     Bob's second tab publishes: Bob's first tab got 0 of its messages in 3 s; Alice's tab is not counted
```

## What happens

1. The worker connects with the tab's key, so the server sees one peer with two connections.
2. The server relays the tab's topics to every connection of the peer. The worker's `Repo` sets up the document from the relayed messages (`synchronizer.receiveMessage`).
3. 5 s after its last handoff, the worker evicts every loaded document ([`EVICT_IDLE_MS = 5_000`](https://github.com/inkandswitch/patchwork-system/blob/bd12be7c10d6145cab0888f025c09b2f291612a7/core/bootloader/src/automerge-protocol-handler-worker.ts), `repo.removeFromCache`). Patchwork's patch makes the Subduction source's `detach` unsubscribe the topic (`subduction.unsubscribeEphemeral`).
4. The server removes the peer from the topic, which includes the tab. The tab never subscribes again.

Independently of the worker, two tabs of one profile don't receive each other's ephemeral messages: the relay doesn't send a message back to its originator's peer.

The tiling frame (`patchwork-frame-tiling`) triggers this on a local Patchwork without its plugin documents (`llm-config-tray`), which is how this bug was found.
