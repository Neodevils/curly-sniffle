# Discord Activity + Multiplayer Plan

## Reality check

Running a SWF in Ruffle and making it truly online multiplayer are different problems.

For an original HTML/JS game, multiplayer can be cleanly added with:

- Discord Embedded App SDK
- Discord Activity instance ID as the room key
- Cloudflare Workers + Durable Objects for WebSocket rooms

For a closed SWF, you usually cannot safely inject real multiplayer into the game logic unless:

- you own the source FLA / ActionScript,
- you can rebuild the game, or
- the SWF already exposes a controllable external API.

## Suggested phases

### Phase 1 - Static playable page

- Host a licensed SWF with Ruffle.
- Publish on GitHub Pages.

### Phase 2 - Discord Activity wrapper

- Create a Discord application.
- Enable Activities.
- Host the client on a public HTTPS URL.
- Use the Embedded App SDK inside the page.
- Use the Activity instance ID as the multiplayer room ID.

### Phase 3 - Cloudflare room server

- Deploy a Cloudflare Worker with a Durable Object room.
- Connect clients through WebSocket.

### Phase 4 - Actual multiplayer

For a SWF:

- presence, lobby, chat, and timers are realistic;
- true synchronized gameplay is usually not realistic without source access.

For a remake:

- implement the game in Phaser, Pixi, Canvas, or plain TypeScript;
- sync player inputs through Durable Objects;
- keep authoritative room state server-side.
