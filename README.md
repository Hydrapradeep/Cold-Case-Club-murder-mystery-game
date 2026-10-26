# Cold Case Club

A multiplayer murder mystery. An AI (OpenAI) writes a new case each game. 2-6 players question suspects, search the scene, share one notebook, then vote on the killer.

## Run locally (Node 20.6+)
1. `cp .env.example .env` and set `OPENAI_API_KEY` (optional: `OPENAI_MODEL`, default `gpt-4o-mini`)
2. `npm install`
3. `npm start`, then open http://localhost:3000 in two tabs

Without an API key the game uses a built-in case and suspects cannot answer.

## Deploy (Render)
1. Push this folder to a GitHub repo (`.env` is git-ignored).
2. On render.com: New > Web Service > connect the repo. Build: `npm install`. Start: `node server.js`.
3. Add the environment variable `OPENAI_API_KEY`.
4. Use the public URL as your project link.

## Files
- `server.js`: rooms, case generation, interrogation, voting (Express + Socket.IO)
- `public/index.html`: the whole client
- `preview.html`: offline demo with a simulated server (not for submission)
