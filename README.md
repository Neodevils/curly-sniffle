# Fire & Water Ruffle Wrapper

This repository hosts a fullscreen single-page Ruffle wrapper for a legal SWF at `swf/game.swf`.

## Important

This repository intentionally does not include Fireboy & Watergirl or any other copyrighted SWF.
Only add a SWF that you created, own, or have permission to distribute.

The multiplayer prototype is input relay only. The SWF is closed and Ruffle runs the game locally, so the Cloudflare Worker does not provide true server-authoritative game-state multiplayer. It coordinates rooms, assigns roles, validates role keys, and relays input events. If Ruffle accepts injected keyboard events, two clients in the same room should stay roughly synced by receiving the same input stream.

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

2. Copy the example config:

```sh
cp cloudflare/wrangler.toml.example cloudflare/wrangler.toml
```

3. Deploy from the Cloudflare directory:

```sh
cd cloudflare
wrangler deploy
```

4. Copy the Worker domain from Wrangler output.

Open the game with:

```txt
https://neodevils.github.io/curly-sniffle/?room=test&server=wss://YOUR_WORKER_DOMAIN/room
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

Mappings are configured in one place in both `index.html` and `cloudflare/worker.js`.

```txt
Fireboy: ArrowLeft, ArrowRight, ArrowUp
Watergirl: KeyA, KeyD, KeyW
```

Room behavior:

```txt
Max active players: 2
Roles: fire, water
Extra clients: spectator
```

The Worker assigns the first active participant to `fire`, the second active participant to `water`, and any additional participant to `spectator`. Each active player can only send input for their assigned role, and the server validates that assignment before relaying input.

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

Discord's official Embedded App SDK exposes `instanceId` immediately after SDK construction. When `discordClientId` is provided and `room` is not provided, the wrapper uses that `instanceId` as the room id, so users joining the same Activity instance land in the same input-relay room.

When the Discord SDK is ready, the small `Invite Friend` button calls Discord's native invite UI through `discordSdk.commands.openInviteDialog()`. Outside Discord, the button stays hidden and the page remains a normal browser game.

Example Activity URL:

```txt
https://neodevils.github.io/curly-sniffle/?discordClientId=YOUR_DISCORD_CLIENT_ID&server=wss://YOUR_WORKER_DOMAIN/room
```

You can still force a specific room:

```txt
https://neodevils.github.io/curly-sniffle/?room=test&discordClientId=YOUR_DISCORD_CLIENT_ID&server=wss://YOUR_WORKER_DOMAIN/room
```

For a real Discord Activity deployment, configure the app in the Discord Developer Portal and add the required Activity URL mappings/proxy settings for the GitHub Pages host, Worker host, Ruffle CDN, and any other external assets you load.
