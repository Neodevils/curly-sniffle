const ROLE_KEYMAP = {
  fire: new Set(["ArrowLeft", "ArrowRight", "ArrowUp"]),
  water: new Set(["KeyA", "KeyD", "KeyW"]),
};

const ACTIVE_ROLES = ["fire", "water"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        [
          "Fire & Water input-relay multiplayer worker.",
          "",
          "WebSocket endpoint:",
          "/room?room=<roomId>&preferredRole=fire|water",
          "",
          "Example client URL:",
          "https://neodevils.github.io/curly-sniffle/?room=test&server=wss://YOUR_WORKER_DOMAIN/room",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }
      );
    }

    if (url.pathname !== "/room") {
      return new Response("Not found", { status: 404 });
    }

    const room = sanitizeRoom(url.searchParams.get("room"));
    if (!room) {
      return new Response("Missing or invalid room", { status: 400 });
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
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");

    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket", {
        status: 426,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const room = sanitizeRoom(url.searchParams.get("room"));
    if (!room) {
      return new Response("Missing or invalid room", { status: 400 });
    }

    const preferredRole = normalizeRole(url.searchParams.get("preferredRole"));
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const session = {
      id: crypto.randomUUID(),
      socket: server,
      role: this.assignRole(preferredRole),
      room,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };

    server.accept();
    this.sessions.set(session.id, session);

    server.addEventListener("message", (event) => this.handleMessage(session, event));
    server.addEventListener("close", () => this.removeSession(session.id));
    server.addEventListener("error", () => this.removeSession(session.id));

    this.send(session, {
      type: "welcome",
      sessionId: session.id,
      role: session.role,
      room,
      players: this.players(),
    });
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  assignRole(preferredRole) {
    if (preferredRole && this.isRoleFree(preferredRole)) {
      return preferredRole;
    }

    for (const role of ACTIVE_ROLES) {
      if (this.isRoleFree(role)) {
        return role;
      }
    }

    return "spectator";
  }

  isRoleFree(role) {
    for (const session of this.sessions.values()) {
      if (session.role === role && session.socket.readyState === WebSocket.OPEN) {
        return false;
      }
    }
    return true;
  }

  handleMessage(session, event) {
    session.lastSeen = Date.now();

    let message = null;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      this.send(session, { type: "error", code: "bad_json", message: "Message must be JSON." });
      return;
    }

    if (message.type === "ping") {
      this.send(session, { type: "pong", t: message.t || Date.now() });
      return;
    }

    if (message.type !== "input") {
      this.send(session, { type: "error", code: "bad_type", message: "Unsupported message type." });
      return;
    }

    const input = this.validatedInput(session, message);
    if (!input) {
      return;
    }

    this.broadcast(input, session.id);
  }

  validatedInput(session, message) {
    if (session.role !== "fire" && session.role !== "water") {
      this.send(session, { type: "error", code: "spectator_input", message: "Spectators cannot send input." });
      return null;
    }

    if (message.role !== session.role) {
      this.send(session, { type: "error", code: "role_mismatch", message: "Input role does not match assigned role." });
      return null;
    }

    if (message.action !== "keydown" && message.action !== "keyup") {
      this.send(session, { type: "error", code: "bad_action", message: "Input action must be keydown or keyup." });
      return null;
    }

    if (!ROLE_KEYMAP[session.role]?.has(message.code)) {
      this.send(session, { type: "error", code: "bad_key", message: "Key is not allowed for assigned role." });
      return null;
    }

    return {
      type: "input",
      action: message.action,
      code: message.code,
      key: typeof message.key === "string" ? message.key : message.code,
      role: session.role,
      seq: Number.isFinite(message.seq) ? message.seq : 0,
      t: Number.isFinite(message.t) ? message.t : Date.now(),
      sessionId: session.id,
    };
  }

  send(session, message) {
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify(message));
    }
  }

  broadcast(message, exceptSessionId = "") {
    const text = JSON.stringify(message);
    for (const session of this.sessions.values()) {
      if (session.id === exceptSessionId) continue;
      if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(text);
      }
    }
  }

  broadcastPresence() {
    this.broadcast({
      type: "presence",
      players: this.players(),
    });
  }

  players() {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      role: session.role,
      joinedAt: session.joinedAt,
      lastSeen: session.lastSeen,
    }));
  }

  removeSession(sessionId) {
    if (this.sessions.delete(sessionId)) {
      this.broadcastPresence();
    }
  }
}

function normalizeRole(value) {
  return value === "fire" || value === "water" ? value : "";
}

function sanitizeRoom(value) {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}
