# Cursed Pact — A JJK Text-Adventure RPG

A multiplayer Jujutsu Kaisen tabletop RPG that runs entirely in the browser.
**Google Gemini** narrates as your Dungeon Master. **Firebase Realtime Database**
syncs the room between players. The whole app is a static site you can host on
GitHub Pages for free.

> _Fan project. Not affiliated with Gege Akutami, Shueisha, or MAPPA._
> _Jujutsu Kaisen and all related characters are © their rightful owners._

---

## What this is

- **Multiplayer text-adventure RPG** in the JJK universe.
- Each player is a jujutsu sorcerer (or curse user), Grade 4 → Special Grade.
- Cursed techniques, cursed energy, dice rolls (d20), domain expansions, the works.
- Gemini plays the **DM**: narrates scenes, voices NPCs (Gojo, Sukuna, Nanami…),
  adjudicates rolls, and tracks your party's HP / CE / status.
- **No backend server.** Everything runs in the browser.

## How it works

- The **host's browser** is the only one that calls Gemini. Other players just
  read/write to Firebase Realtime Database. This way you don't accidentally
  spend 4× the API quota for a 4-player party.
- Each player pastes **their own** Gemini API key on first load. The key is
  stored only in `localStorage`, never sent anywhere except directly to Google.
- Anonymous Firebase Auth gives each player a stable UID without sign-up.

## Tech stack

- Vanilla HTML / CSS / ES-modules JavaScript. **No build step.**
- Firebase v10 modular SDK loaded straight from Google's CDN.
- `marked` from jsDelivr for DM markdown rendering.
- Gemini `gemini-2.5-flash` via REST.

---

## Setup

You need:
1. A Firebase project (free Spark tier).
2. A Google AI Studio Gemini API key (each player will need their own, free
   tier is fine).
3. A static host — GitHub Pages works perfectly.

### 1. Clone & configure Firebase

```bash
git clone <your-fork-url> cursed-pact
cd cursed-pact
```

In the [Firebase console](https://console.firebase.google.com/):

1. **Create a new project** (anything you like, e.g. `cursed-pact`).
2. Open **Build → Realtime Database** → Create Database (pick a region).
3. Open **Build → Authentication** → Get started → enable **Anonymous** sign-in.
4. **Project Settings → General → Your apps** → click the **`</>`** icon
   (Web). Register an app and copy the `firebaseConfig` object.
5. Paste it into `src/firebase.config.js`, replacing the placeholder values.

> The Firebase web config is technically public-facing — Google says so. But
> **your security rules are what protect you.** Set them in the next step.

### 2. Lock down your database

In the Firebase console: **Realtime Database → Rules**. Paste:

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": "auth != null",
        ".write": "auth != null",
        ".validate": "$roomId.matches(/^[A-Z0-9]{6}$/)",

        "host":            { ".validate": "newData.isString() && newData.val().length < 256" },
        "createdAt":       { ".validate": "newData.isNumber() || newData.val() == now" },
        "status":          { ".validate": "newData.isString() && newData.val().length < 32" },
        "currentTurn":     { ".validate": "newData.isString() ? newData.val().length < 256 : newData.val() == null" },

        "players": {
          "$uid": {
            ".validate": "auth.uid == $uid || data.exists()",
            "uid":     { ".validate": "newData.val() == $uid" },
            "name":    { ".validate": "newData.isString() && newData.val().length <= 64" },
            "online":  { ".validate": "newData.isBoolean()" },
            "lastSeen":{ ".validate": "newData.isNumber() || newData.val() == now" }
          }
        },

        "messages": {
          "$msgId": {
            ".validate": "newData.hasChildren(['author','type','content']) && newData.child('content').isString() && newData.child('content').val().length <= 4000"
          }
        },

        "pendingActions": {
          "$uid": {
            ".write": "auth.uid == $uid || (root.child('rooms').child($roomId).child('host').val() == auth.uid)",
            ".validate": "newData.isString() ? newData.val().length <= 8000 : true"
          }
        },

        "turnOrder": {
          ".validate": "newData.val() === null || newData.hasChildren()"
        }
      }
    }
  }
}
```

**Why these rules:**
- Only authenticated users (anonymous auth is fine) can read or write.
- Room codes are restricted to 6 uppercase alphanumerics so attackers can't
  flood the DB with weird paths.
- Players can only edit their **own** player record (modulo the host clearing
  pending actions).
- Message content size is capped to 4 KB to prevent abuse.

> **Free-tier note:** the Spark plan gives you 1 GB stored / 10 GB downloaded
> per month. The chat log of a long campaign is well within this; just don't
> leave the tab open with hundreds of messages over thousands of pageloads.

### 3. Run locally

You don't need npm at all if you have any static-file server installed. Pick
whichever you like:

```bash
# Option A — npm (uses npx serve, no install needed)
npm run dev   # → http://localhost:5173

# Option B — Python
python -m http.server 5173

# Option C — VS Code "Live Server" extension
```

Open **two** browser windows pointing at `http://localhost:5173/index.html`
(use a private window for the second tab so they get separate localStorage /
anonymous UIDs). Each one pastes their Gemini key, then one creates a room
and the other joins via the 6-character code.

### 4. Deploy to GitHub Pages

The repo is a plain static site, so any Pages mode works:

**Option A — push and enable Pages on `main`** (simplest):

```bash
git add .
git commit -m "Initial commit"
git remote add origin git@github.com:<your-username>/cursed-pact.git
git push -u origin main
```

Then in the GitHub UI: **Settings → Pages → Build and deployment**:
- Source: **Deploy from a branch**
- Branch: `main` / root (`/`)

Visit `https://<your-username>.github.io/cursed-pact/`.

**Option B — `npm run deploy`** (publishes to a `gh-pages` branch):

```bash
npm run deploy
```

Then in GitHub: **Settings → Pages → Source: `gh-pages` branch / root**.

> Because there is no bundler, no `base` path config is needed — relative
> paths in `index.html` resolve correctly under `/<repo-name>/`.

---

## How to play

1. Open the URL. Paste your Gemini API key (one-time per browser).
2. Click **Create room** → copy the 6-character code → share with friends.
3. Each friend opens the URL, pastes their own key, hits **Join** with the code.
4. Everyone fills out a sorcerer:
   - **Name**, **starting grade** (Grade 3 by default), **cursed technique**
     (write your own or pick from the list), basic stats, optional **domain
     expansion** description.
5. The first turn auto-belongs to whoever joined first. They type an action,
   roll a d20 if asked, and hit **Send**.
6. The host's browser calls Gemini, the response is written back to Firebase,
   everyone sees the DM narration and updated party panel.

### Combat & rolls
- The DM will request rolls when the outcome is uncertain. A **d20 + stat-mod**
  prompt appears in the chat — click **Roll d20** to commit it.
- You can also pre-roll a d20 with the small `d20` button next to **Send**;
  the result gets attached to your next action.

### Cursed energy / domain expansion
- Cursed energy (CE) is consumed by techniques. The DM tracks it.
- Domain expansion is intentionally expensive: ~50% remaining CE plus a
  binding-vow toll. Use it when you really mean it.

---

## Repo layout

```
.
├── index.html                  # entry, three views inside one document
├── styles.css                  # dark theme, JJK violet accents
├── package.json                # optional dev/deploy scripts
├── .gitignore
├── README.md
└── src/
    ├── main.js                 # bootstraps views + auth
    ├── firebase.js             # Firebase init + room helpers
    ├── firebase.config.js      # YOUR Firebase web config (placeholders)
    ├── firebase.config.example.js
    ├── gemini.js               # Gemini wrapper + DM system prompt
    ├── game/
    │   ├── character.js        # character creation, technique list
    │   ├── combat.js           # dice + state-change application
    │   └── room.js             # turn orchestration, host DM-trigger
    └── ui/
        ├── common.js
        ├── lobby.js
        ├── character.js
        └── game.js
```

## Security notes (read this)

- **Never put your Gemini API key in the source.** This app stores it in
  `localStorage` only. The repo is public — keys committed to a public repo
  are scraped within minutes.
- **Don't trust the client.** Your Firebase rules above are the only thing
  preventing strangers from reading other rooms. Apply them before sharing
  the URL with anyone.
- **The Firebase web config is fine to commit** — but only because the rules
  enforce auth and path constraints. Don't ship without them.

## Troubleshooting

- **"Firebase config not set"** — you didn't replace the placeholders in
  `src/firebase.config.js`.
- **Permission denied writing to /rooms/...** — your security rules aren't
  applied or your project doesn't have Anonymous auth enabled.
- **DM never speaks** — only the host's browser calls Gemini. Make sure the
  host has the tab open with a valid Gemini key.
- **DM JSON not parsed** — the model occasionally drops the fenced JSON. The
  app survives this (no state changes that turn) and the next turn is fine.

## License

MIT. The JJK setting and characters are © Gege Akutami / Shueisha / MAPPA.
This project is fan-made and non-commercial.
