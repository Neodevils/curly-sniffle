# Ruffle + GitHub Pages SWF Player

This repository is a clean static-site scaffold for running a licensed SWF file with Ruffle on GitHub Pages.

## Important

This repository intentionally does not include Fireboy & Watergirl or any other copyrighted SWF.
Only add a SWF that you created, own, or have permission to distribute.

## Add your SWF

Place your legal SWF at:

```txt
swf/game.swf
```

Then commit and push.

## Enable GitHub Pages

1. Open the repository on GitHub.
2. Go to Settings -> Pages.
3. Source: Deploy from a branch.
4. Branch: main.
5. Folder: /(root).
6. Save.

The site should become available at:

```txt
https://neodevils.github.io/curly-sniffle/
```

## Discord Activity and multiplayer

A SWF running through Ruffle is not automatically multiplayer. For a Discord Activity, the realistic plan is:

1. Wrap the web app with Discord's Embedded App SDK.
2. Use the Discord Activity instance ID as the room key.
3. Use Cloudflare Workers + Durable Objects for WebSocket rooms.
4. Sync lobby, presence, chat, timers, and external controls.

True synchronized gameplay usually requires owning the game source or remaking the game in HTML5.
