# Cursed Pact — context for Claude Code

A multiplayer Jujutsu Kaisen text-adventure RPG. Static site on GitHub Pages,
multiplayer state on Firebase Realtime DB, accounts + saved builds on the
user's Ubuntu home server. The DM brain is either Google Gemini (cloud) or a
local Ollama install (host's PC). **Only the host's browser calls the LLM.**

## URLs you'll want

- **Live site:** https://layerborn.github.io/cursed-pact/
- **Public repo (this one):** https://github.com/LayerBorn/cursed-pact
- **Backend repo (private, has the `/api/cp/*` API):** https://github.com/LayerBorn/layerbornmanagement
- **Backend tunnel URL (rotates on cloudflared restart):** see `MGMT_API_BASE` in `src/cpApi.js`. Currently `https://controlled-results-referral-finances.trycloudflare.com`.
- **Firebase project:** `dndthing-8ab15`. Console: https://console.firebase.google.com/project/dndthing-8ab15/

## Architecture at a glance

```
Player browser → layerborn.github.io/cursed-pact   (static, free)
       │
       ├──→ Firebase Realtime DB         (rooms, players, messages, votes, map)
       │    Auth: anonymous + email/password (Firebase Auth)
       │
       └──→ cloudflared tunnel → 192.168.1.15:3001   (the home server)
            /api/cp/auth/*    accounts (cp_users table)
            /api/cp/builds/*  saved character builds (cp_builds table)
```

The host's browser also calls **out** to Gemini OR a local Ollama at
`http://localhost:11434`. Joiners never call the LLM.

## Repo layout

```
cursed-pact/
├── index.html              all views in one document (auth, lobby, character, game, builds, settings)
├── styles.css              one stylesheet, no preprocessor
├── package.json            optional dev/deploy scripts; the site needs no build step
├── README.md               player-facing readme
├── CLAUDE.md               this file
└── src/
    ├── main.js                 boot + view router; defensive boot wrapper
    ├── firebase.js             Firebase init, auth helpers, room CRUD,
    │                           kickPlayer, snapshots, deleteMessage
    ├── firebase.config.js      live Firebase web config (committed)
    ├── cpApi.js                HTTP client for the home-server backend
    ├── gemini.js               DM provider abstraction (Gemini + Ollama),
    │                           DM_SYSTEM_PROMPT, callDm dispatcher,
    │                           buildTurnUserMessage, parseDmResponse,
    │                           generateAbilities, rebalanceAbilities
    ├── game/
    │   ├── character.js        defaults, GRADE_ORDER, XP_TO_NEXT, promoteCharacter
    │   ├── combat.js           rollD20, applyMechanicsToCharacter (BOUNDED state changes)
    │   └── room.js             runDmTurn (chain logic), generateMissingAbilities,
    │                           submitPartyAction, tallyVotes, rerunLastDmTurn
    ├── util/
    │   └── profanity.js        client-side filter with leet-normalization
    └── ui/
        ├── common.js           $, show, toast, el, copyToClipboard, colorForUid,
        │                       buildTranscript, downloadAsFile
        ├── auth.js             sign-in / sign-up / continue-as-guest
        ├── builds.js           My Builds + build editor + manual ability editor
        ├── account.js          settings view + verification banner + avatar helpers
        ├── lobby.js            create / join room
        ├── character.js        character creation + Use saved build
        ├── game.js             main game UI (party, chat, map, turn banner, action prompt)
        └── debug.js            Ctrl+D debug panel + verifyRoomInvariants
```

## Backend (Layerborn server)

This repo's frontend talks to a private Express+SQLite backend running under
PM2 on the user's Ubuntu home box. The CP-specific code there:

- `D:\layerbornmanagement\backend\database.js` — `cp_users`, `cp_builds` tables
- `D:\layerbornmanagement\backend\server.js` — `/api/cp/*` routes (search the file for `/api/cp`); registered ABOVE the SPA fallback per the route-ordering rule
- `D:\layerbornmanagement\backend\cpmail.js` — nodemailer wrapper for verification emails (Gmail SMTP via `SMTP_USER` + `SMTP_PASS` in `.env`)

JWT secret is shared with Layerborn's own auth but CP tokens carry `kind: "cp"`
so they can never pass Layerborn's `auth` middleware.

## Common workflows

### Deploy a frontend change (this repo)

```bash
git add .
git commit -m "..."
git push                       # GitHub Pages auto-deploys main branch
```

Hard refresh in browser to pick it up. Pages takes ~30 seconds.

### Deploy a backend change (layerbornmanagement repo)

```bash
# Local edit + commit + push as usual
git -C ~/path/to/layerbornmanagement push

# Then on the Ubuntu server:
ssh -i ~/.ssh/quandale_key leo@192.168.1.15 \
  "cd ~/layerbornmanagement && git pull origin master && \
   cd backend && npm install --production && \
   pm2 restart layerborn-mgmt"
```

If the cloudflared tunnel URL changes (process restart), update
`MGMT_API_BASE` in `src/cpApi.js` and push.

### Run locally

```bash
npm run dev   # → http://localhost:5173 via npx serve
```

Or any static-file server. There is **no build step**.

## Recent decisions worth knowing

- **Routing**: every view is in `index.html`. `show("view-X")` from `common.js`
  swaps the `.active` class. Boot routes to `view-auth` if no signed-in user,
  `view-lobby` otherwise.
- **Turn enforcement**: `currentTurn` is the source of truth in
  `room.currentTurn`. `sendAction` and `submitOption` reject submits when
  `room.currentTurn !== me` AND there's no group vote / individual prompt
  directed at the player. The action input + send button visually disable
  too. Don't relax this without a reason.
- **Ability validation**: `abilityValidationNote()` in `ui/game.js` annotates
  the player's text with a SYSTEM NOTE if they reference an ability not in
  their list. Local models that ignore the system prompt's "refuse" rule
  still see the note inline.
- **State change bounds**: `applyMechanicsToCharacter` in `game/combat.js`
  caps every numeric delta. Don't remove these caps — they're the only thing
  stopping a hallucinating DM from corrupting state.
- **Snapshots**: `runDmTurn` writes a pre-run snapshot to `_lastSnapshot` so
  the host can hit `↻ rerun` to revert. Includes `players, objective, map,
  actionPrompt, votes, currentTurn, turnOrder, pendingActions,
  messageIdsBefore`.
- **Debug panel**: `Ctrl+D` in the game view. Live snapshot of room state +
  `Verify state` button + `Copy snapshot`. State persists across reloads via
  `localStorage`.

## Known gotchas

- **The cloudflared trial tunnel URL changes on restart.** When that happens,
  `MGMT_API_BASE` in `src/cpApi.js` is stale and the accounts feature breaks.
  Edit + push to fix. (Long-term fix: named tunnel under the user's
  Cloudflare account.)
- **The host's `dmRunning` flag is in-memory.** A host refresh mid-DM-call
  can re-trigger the run. Audit issue #11 in the last review — not fixed
  yet.
- **Local Ollama with smaller models occasionally hallucinates** abilities or
  ignores the system prompt. The annotation layer catches most cases. The
  rerun button is the manual safety net.
- **`OLLAMA_ORIGINS` env var on the host's PC** must include
  `https://layerborn.github.io` so the browser can call `localhost:11434`.

## Recent commits worth reading

```
006b2fe   Big robustness pass — turn enforcement, ability validation, state caps
29c103e   Fix duplicate submissions, tighten ability validation, prune "thinking" msgs
3f21bc3   Debug tools: Ctrl+D panel, turn-transition logging, verify-state
2a54720   Fix scroll lockup + DM addresses current player by name
e3a7320   User accounts + saved builds (free, no payments)
9e2cb37   Move accounts + builds to home server (cpApi.js)
```

## What an agent should NOT do

- Don't put the API key in source. The repo is public.
- Don't change `firebase.config.js` placeholder values without confirming with
  the user — those are real public-facing project IDs.
- Don't relax the turn-enforcement / ability-validation / state-bound caps
  without explicit confirmation; they're load-bearing.
- Don't bypass the rate limiters in `submitOption` / `sendAction`
  (`actionInFlight` lock + 3-second dedup).
- Don't add new features that require Firebase rule changes without telling
  the user — they have to paste the new rules into the console manually.
- Don't enable GitHub Pages automatically if it's already on; just push.
