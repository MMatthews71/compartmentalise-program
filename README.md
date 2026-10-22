# Compartmentalise

A tiny desktop app for letting an AI edit your Python code without seeing your
secrets. Open a file, mark the bits that are secret, and the app moves them
into a separate file — `hidden_secrets.py` — and rewrites your file to
`import` them. The rewritten file still runs exactly as before, so an AI can
read and edit it freely while the real values stay in a file you never give it.

The point: **you never hand your API keys, passwords, hostnames, column names
or anything else sensitive to a third-party model.**

## How it works

1. Click **Open file…** and pick a `.py` file (or paste code into the left box
   to try it out).
2. Add the secrets in the **Secrets** section:
   - select text in the code and press **Ctrl/Cmd + E**, or
   - click **+ Add secret** and type or paste it (secrets can span lines), or
   - click **Auto-detect** to find things that look like secrets (API keys,
     tokens, emails, IPs, `password = "…"`, JWTs, URLs with credentials).
     Always review what it finds.
3. The right box shows what the AI will see. Switch to **Secrets file** to see
   what goes into `hidden_secrets.py`.
4. Click **Save**. Your file is rewritten and the secrets are added to
   `hidden_secrets.py` in the same folder (it's created if needed, and new
   secrets are added to any already there).

Each secret has a **name** — what your code uses instead of the real value
(auto-filled as `SECRET_1`, `SECRET_2`…; rename it to something meaningful).

### What gets moved, and how

| You mark…                                   | Your file becomes…                    | `hidden_secrets.py` gets…   |
| ------------------------------------------- | ------------------------------------- | --------------------------- |
| a whole top-level variable `API_KEY = "sk…"` | the line is removed                   | `API_KEY = "sk…"`           |
| a complete value `["ts_hk", "active_USD"]`  | `cols = COLS`                         | `COLS = ["ts_hk", …]`       |
| a whole string `"db.internal"`              | `connect(DB_HOST)`                    | `DB_HOST = "db.internal"`   |
| part of a string: `abc` in `"abcdef"`       | `f"{SECRET_1}def"`                    | `SECRET_1 = "abc"`          |
| inside an f-string: `f"{d['active_USD']}"`  | `f"{d[COL]}"`                         | `COL = "active_USD"`        |
| text in a comment or docstring              | the text is replaced by the name      | the text, for reference     |

Every file that uses a secret gets `from hidden_secrets import …` at the top.

Matching rules:
- **Inside strings and comments**, a secret matches anywhere — `abc` is found
  inside `"abcdef"`.
- **In code**, a secret only matches whole values — `abc` never touches a
  variable called `abcd`.
- Spaces, tabs and line breaks are flexible in code, so a multi-line list
  still matches if its indentation differs from what you typed.

If a spot can't be moved without breaking your code (for example a variable
inside a function, a name rather than a value, or an f-string `{x=}` that
prints its own code), it is **left as it is and
listed in red under that secret** so you know the AI will still see it.

## Keep the secrets file away from the AI

Saving puts the real values in `hidden_secrets.py`, so make sure your AI tool
can't read it and it never ends up in git:

- **git:** add `hidden_secrets.py` to `.gitignore`.
- **Claude Code:** add a deny rule to `.claude/settings.json`:
  `{"permissions": {"deny": ["Read(**/hidden_secrets.py)"]}}`
- **Cursor:** add `hidden_secrets.py` to `.cursorignore`.

You can change the secrets file's name in the box at the top of the Secrets
section.

## Privacy

- Nothing is sent over the network — the app has no network access at all.
- The app only reads the file you open and the secrets file next to it, and
  only writes those two files when you click **Save** (and confirm).

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
