/**
 * Cloudflare Workers + Durable Objects multiplayer room skeleton.
 *
 * This does not modify the Flash game internally. It creates a WebSocket room
 * for the surrounding web page or Discord Activity shell.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/room") {
      return new Response("Not found", { status: 404 });
    }

    const room = url.searchParams.get("room");
    if (!room) {
      return new Response("Missing room", { status: 400 });
    }

    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

export class MultiplayerRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
  }

  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.sessions.add(server);

    server.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      for (const socket of this.sessions) {
        if (socket !== server && socket.readyState === WebSocket.OPEN) {
          socket.send(text);
        }
      }
    });

    server.addEventListener("close", () => this.sessions.delete(server));
    server.addEventListener("error", () => this.sessions.delete(server));

    return new Response(null, { status: 101, webSocket: client });
  }
}
