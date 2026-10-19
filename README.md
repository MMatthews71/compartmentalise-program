# Compartmentalise

A tiny desktop app for safely sharing code with an AI. Paste your code, mark
the bits that are secret, and the app swaps every secret for a harmless
placeholder. Copy the sanitised version into the AI. When the AI replies, paste
its answer back and the app puts your real secrets back in.

The point: **you never hand your API keys, passwords, hostnames, or anything
else sensitive to a third-party model.**

## How it works

**Sanitise mode**

1. Paste your code into the left box.
2. Add the things you want to hide in the **Secrets** section. Each secret has:
   - a **value** — the real text to hide (`sk-live-abc123`, a password, a
     hostname…)
   - a **placeholder** — what the AI sees instead (auto-filled as
     `__SECRET_1__`; rename it to something meaningful like `__API_KEY__`).
3. The right box shows the sanitised code, with a count of how many times each
   secret was hidden. Click **Copy** and paste it into the AI.

Shortcuts:
- Select text in the code box and press **Ctrl/Cmd + E** to add it as a secret.
- **Auto-detect** scans the pasted code for things that look like secrets
  (API keys, tokens, emails, IPs, `password = "…"` assignments, JWTs, URLs with
  credentials) and adds them for you. Always review what it finds.

**Restore mode**

Paste the AI's reply (placeholders and all) into the left box and your real
secrets reappear on the right. Keep the app open between the two steps so it
remembers your secret list.

## Privacy

- Secrets live **only in the app window's memory**. Nothing is written to disk
  and nothing is sent over the network — the app has no network access at all.
- Closing the app forgets every secret.

## Running it

```bash
npm install
npm start
```

Requires [Node.js](https://nodejs.org/). `npm install` pulls in Electron.

## Building a distributable (optional)

This repo ships only the source. To produce a packaged app, add a packager such
as [`electron-builder`](https://www.electron.build/) or
[`@electron-forge/cli`](https://www.electronforge.io/) and follow its docs.
