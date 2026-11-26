# Point Gomoku — Puter.js P2P Online Game

A serverless, browser-to-browser multiplayer implementation of **Point Gomoku** from *The Devil's Plan: Dead Again* (Season 3, Episode 13), powered by **Puter.js (`puter.peer`)**.

## Features
- **Direct Peer-to-Peer Multiplayer (`puter.peer`)**: Host a private room with `puter.peer.serve()` to generate an invite code (and direct `?join=CODE` link), and connect directly over WebRTC with `puter.peer.connect(inviteCode)` — zero backend servers required.
- **Fair Cryptographic Commit-Reveal Bidding**: Each player's secret bet is hashed with SHA-256 (`BET_COMMIT`) before exchange and only revealed (`BET_REVEAL`) once both peers have locked in, preventing peeking.
- **Faithful S3E13 Rules**:
  - 15×15 Gomoku board.
  - Alternating **Selector** each round with a **90-second timer** to pick **3 consecutive empty intersections** (horizontal, vertical, or diagonal).
  - **+10 points** per round, **minimum 1 whole point** per spot.
  - **Carry-over rule**: Half of unspent points (rounded down) carry over to the next round.
  - **Tie-breaker**: The **non-selector** wins any tied spot.
  - First player to connect **5 stones in a row** wins.
- **Live Peer Chat & Round History** over the same Puter Peer data channel.
- **Instant Practice Modes**: Play solo against a strategic **Exile AI** bot or play **Local 2-Player (Pass & Play)** with a privacy screen between secret bets.

## Running Locally
Because the app uses ES modules (`type="module"`), serve `/home/user/point-gomoku` with any static HTTP server:

```bash
cd /home/user/point-gomoku
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

## Deploying to Puter Hosting
Deploy via the Puter CLI (`@heyputer/cli`):
```bash
npm install -g @heyputer/cli
puter login
cp /home/user/point-gomoku/{index.html,styles.css,app.js,game-engine.js} /home/user/point-gomoku/dist/
puter site deploy /home/user/point-gomoku/dist point-gomoku-exile
```
Live at: https://point-gomoku-exile.puter.site

## Running Engine Tests
```bash
node /home/user/point-gomoku/test-engine.mjs
```
