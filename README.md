# Fire & Water Ruffle Wrapper

This repository hosts a fullscreen single-page Ruffle wrapper for a legal SWF at `swf/game.swf`.

## Important

This repository intentionally does not include Fireboy & Watergirl or any other copyrighted SWF.
Only add a SWF that you created, own, or have permission to distribute.

The multiplayer prototype runs one local Ruffle instance per player. The SWF is closed and Ruffle runs the game locally, so the Cloudflare Worker does not provide true server-authoritative game-state simulation. It coordinates rooms, assigns roles, validates role keys, and relays input events between players. Both players should choose the same level locally, then one controls Fireboy and the other controls Watergirl.

If desync happens, the proper solution is remaking the game in HTML5 or modifying/owning the original game source.

## Add your SWF

Place your legal SWF at:

```txt
swf/game.swf
```

Then commit and push.

## GitHub Pages

1. Open the repository on GitHub.
2. Go to Settings -> Pages.
3. Source: Deploy from a branch.
4. Branch: `main`.
5. Folder: `/(root)`.
6. Save.

The site should become available at:

```txt
https://neodevils.github.io/curly-sniffle/
```

The app still works as a normal single-player fullscreen Ruffle page without a server URL. Missing `server` is not an error; multiplayer is enabled only when a WebSocket server URL is provided.

## Cloudflare Worker

1. Install Wrangler:

```sh
npm install -g wrangler
```

2. Deploy the multiplayer API Worker from the repository root:

```sh
wrangler deploy
```

3. Configure Discord OAuth secrets on the Worker. The client secret must stay server-side:

```sh
wrangler secret put DISCORD_CLIENT_SECRET
wrangler secret put DISCORD_CLIENT_ID
```

`DISCORD_CLIENT_ID` can be omitted when using the default app id `1520427674860912660`.
Do not set `DISCORD_REDIRECT_URI` for the embedded Activity SDK flow. The SDK handles returning to the Activity frame, and the token exchange should omit `redirect_uri` unless a separate redirect-based client flow sends the same value explicitly.

4. Use the deployed Worker domain as the multiplayer WebSocket server.

Current Worker:

```txt
https://fireboy-watergirl.neodevils-contact.workers.dev/
```

Health check:

```txt
https://fireboy-watergirl.neodevils-contact.workers.dev/health
```

Open the game with:

```txt
https://neodevils.github.io/curly-sniffle/?room=test&server=wss://fireboy-watergirl.neodevils-contact.workers.dev/room
```

Optional query parameters:

```txt
?room=<roomId>
?role=fire
?role=water
?server=wss://YOUR_WORKER_DOMAIN/room
?discordClientId=<DISCORD_APPLICATION_CLIENT_ID>
```

If `room` is missing, the page generates a short room id and writes it into the URL. If `server` is missing, the page silently stays single-player.

## Controls

Mappings are configured in one place in both `index.html` and `src/worker.ts`.

```txt
Fireboy: ArrowLeft, ArrowRight, ArrowUp
Watergirl: KeyA, KeyD, KeyW
```

Room behavior:

```txt
Max active players: 2
Initial roles: fire, water
Extra clients after two active players: spectator
```

The Worker assigns the first participant to `fire` and the second participant to `water`. Each player keeps their own local SWF view and can navigate menus or enter levels locally. Once both players are in the same level, each active player can only send input for their assigned role, and the server validates that assignment before relaying input.

Debug room/status details are hidden by default. Add `?debug=1` to show the diagnostic overlay.

## Mobile Controls

The page includes touch D-pads:

```txt
Single-player: shows both Fireboy and Watergirl pads
Multiplayer fire role: shows Fireboy pad only
Multiplayer water role: shows Watergirl pad only
Spectator: hides both pads
```

Touch controls are shown only when JavaScript device detection reports `phone` or `tablet`; desktop does not show D-pads. Touch controls dispatch keyboard events into Ruffle locally. In multiplayer, they also relay the assigned role's input through the Worker.

## Discord Activity

The page can run as a Discord Activity wrapper without changing the normal GitHub Pages flow.

Discord's official Embedded App SDK exposes `instanceId` immediately after SDK construction. When `discordClientId` is provided and `room` is not provided, the wrapper uses that `instanceId` as the room id, so users joining the same Discord Activity instance land in the same Worker room.

When the Discord SDK is ready, the Activity requests OAuth permission through `authorize`, exchanges the code through the Worker at `/api/auth/discord/token`, authenticates the SDK session, and calls `setActivity` so Discord can show the Activity status.

The top-right Activity UI only shows the local role:

```txt
Host - Fireboy
Guest - Watergirl
Spectator
```

The first active participant is the host/fire role. The second participant is the guest/water role. Both participants keep their own local Ruffle screen, choose the same level locally, and then send only their assigned movement input through the relay.
Additional participants join as spectators and cannot send movement input.

Production browser URL:

```txt
https://neodevils.github.io/curly-sniffle/
```

You can still force a specific room:

```txt
https://neodevils.github.io/curly-sniffle/?room=test&discordClientId=YOUR_DISCORD_CLIENT_ID&server=wss://fireboy-watergirl.neodevils-contact.workers.dev/room
```

Discord Developer Portal setup:

```txt
Activity URL:
https://neodevils.github.io/curly-sniffle/

Allowed/proxied external origins:
https://neodevils.github.io
https://fireboy-watergirl.neodevils-contact.workers.dev
```

Discord URL mappings:

```txt
/    -> https://neodevils.github.io/curly-sniffle/
/api -> https://fireboy-watergirl.neodevils-contact.workers.dev
```

Inside Discord, the app detects the `discordsays.com` Activity frame and automatically uses:

```txt
Client ID: 1520427674860912660
WebSocket: /api/room
```

OAuth scopes to request when adding authentication:

```txt
identify
rpc.activities.write
```

Required Worker secret:

```txt
DISCORD_CLIENT_SECRET
```

Optional Worker var:

```txt
DISCORD_CLIENT_ID
```

If you use a redirect-based local OAuth flow, add this redirect URL in the Discord Developer Portal:

```txt
http://localhost:5173/auth/discord/callback
```

For the GitHub Pages deployment, add this production redirect URL if Discord asks for one:

```txt
https://neodevils.github.io/curly-sniffle/auth/discord/callback/
```

For the embedded Discord Activity flow, the app uses Discord's SDK `authorize` command inside the Activity iframe and exchanges the returned code through `/api/auth/discord/token`.

For a real Discord Activity deployment, configure the app in the Discord Developer Portal and add the required Activity URL mappings/proxy settings for the GitHub Pages host and Worker host.
