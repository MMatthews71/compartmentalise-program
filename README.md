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

**Folder mode** — hide terms across a whole project

1. Click **Open folder…** and pick your project folder.
2. Click any file, select a term (an API key, a company name, a module name…)
   and press **Ctrl/Cmd + E** (or **Hide selection**). The term is hidden in
   **every** text file in the folder — `.py`, `.json`, `.ipynb`, `.js`, `.yaml`,
   `.env`, `.md` and so on — and in file and folder names too. The file list
   shows how many hits each file has; **Safe copy** shows a file as the AI
   will see it.
3. Click **Export safe copy…**. The app writes a copy of the whole folder with
   every hidden term swapped for its placeholder. Your original files are not
   changed. Because the same term becomes the same placeholder everywhere,
   imports, config keys and lookups still line up, so the safe copy works the
   same way the original does.
4. Give the safe copy to the AI. When it's done, click **Restore AI's
   folder…**, pick its edited copy, then choose where to write the result. You
   can pick your original project folder to apply the AI's changes directly
   onto it.

**Already have a secrets file?** Click **Import secrets file…** (in the
secrets panel) and pick it. Every value in it is hidden across the whole
folder at once, with placeholders named after your variables (`API_KEY` →
`__API_KEY__`). It understands:
- `.env` files (`API_KEY=…`, `export TOKEN="…"`)
- Python files (`API_KEY = "…"`)
- YAML/INI-style `key: value` lines
- JSON objects (`{"apiKey": "…", "db": {"password": "…"}}`)
- Compartmentalise's own `secrets.json`
- a plain list, one term per line

Numbers, `true`/`false`, very short values and non-literal values (like
`os.getenv(...)`) are skipped, because replacing them would change what the
code does. Add them by hand if you really want them hidden.

The real values are saved in `compartmentalise-secrets/secrets.json` inside your
project. That folder is never included in a safe copy, and it holds its own
`.gitignore`, so git ignores it without you editing yours. When you open the
folder again, the same terms are hidden automatically.

Details:
- **JSON files** are handled properly. Values stored with escapes (quotes,
  backslashes) are still found, and placeholders are written so the file stays
  valid JSON. Before exporting, the app warns you if a file would stop being
  valid JSON. For example, a hidden number such as a port would become text.
- Keep placeholders as plain names (letters, digits, `_`, like the default
  `__SECRET_1__`). Then a hidden term that is a variable, module or key name
  still works as code.
- Files the app can't scan (images, binaries, files over 2 MB, non-UTF-8 text)
  are copied unchanged, and the app tells you how many there are.
- `.git`, `node_modules`, `__pycache__`, `venv`/`.venv` and similar folders are
  left out. Git history still holds every old secret.

**Restore mode**

Paste the AI's reply (placeholders and all) into the left box and your real
secrets reappear on the right. Keep the app open between the two steps so it
remembers your secret list.

## Privacy

- Nothing is ever sent over the network. The app has no network access at all.
- In Sanitise mode, secrets live **only in the app window's memory**. Closing
  the app forgets them.
- In Folder mode, secrets are saved only to
  `<your project>/compartmentalise-secrets/secrets.json` (git-ignored). Keep
  that folder private. Delete it to forget the secrets.

## Running it

**Windows:** double-click **`run.bat`**. It installs dependencies on the first
run and then launches the app.

To pull the latest version from GitHub and then run, double-click
**`update.bat`** instead. To keep the folder updated with no clicks at all, see
[Staying up to date automatically](#staying-up-to-date-automatically).

**Any platform (terminal):**

```bash
npm install
npm start
```

Requires [Node.js](https://nodejs.org/). `npm install` pulls in Electron.

## Staying up to date automatically

The app lives in a GitHub repo. Updates are *pushed* there; your local folder
*pulls* them. `update.bat` does one pull-and-run. To make it fully hands-off on
Windows, have Task Scheduler pull on a schedule:

1. Open **Task Scheduler** → **Create Basic Task**.
2. Name it e.g. "Update Compartmentalise", pick a trigger (**At log on**, or
   **Daily**/hourly).
3. Action: **Start a program**.
   - Program/script: `git`
   - Add arguments: `pull`
   - Start in: the full path to this folder, e.g. `C:\Users\you\compartmentalise-program`
4. Finish.

Now your folder quietly stays current; double-click `run.bat` whenever you want
to use it, and it'll already be the latest. (Both `git` and the folder having
been cloned once with `git clone` are required.)

## Building a distributable (optional)

This repo ships only the source. To produce a packaged app, add a packager such
as [`electron-builder`](https://www.electron.build/) or
[`@electron-forge/cli`](https://www.electronforge.io/) and follow its docs.
