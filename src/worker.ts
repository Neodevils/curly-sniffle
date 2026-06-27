const ROLE_KEYMAP = {
  fire: new Set(["ArrowLeft", "ArrowRight", "ArrowUp"]),
  water: new Set(["KeyA", "KeyD", "KeyW"])
};

const ACTIVE_ROLES = ["fire", "water"] as const;

type PlayerRole = "fire" | "water" | "spectator";

type Env = {
  ROOMS: DurableObjectNamespace;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", {
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      });
    }

    if (url.pathname === "/") {
      return new Response("Fireboy & Watergirl multiplayer API", {
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      });
    }

    if (url.pathname === "/room") {
      const room = sanitizeRoom(url.searchParams.get("room"));
      if (!room) {
        return new Response("Missing or invalid room", {
          status: 400,
          headers: {
            "content-type": "text/plain; charset=utf-8"
          }
        });
      }

      const id = env.ROOMS.idFromName(room);
      const roomObject = env.ROOMS.get(id);
      return roomObject.fetch(request);
    }

    return new Response("Not found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }
};

export class MultiplayerRoom {
  private sessions = new Map<
    string,
    {
      id: string;
      socket: WebSocket;
      role: PlayerRole;
      room: string;
      joinedAt: number;
      lastSeen: number;
    }
  >();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", {
        status: 426,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      });
    }

    const room = sanitizeRoom(url.searchParams.get("room"));
    if (!room) {
      return new Response("Missing or invalid room", {
        status: 400,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const session = {
      id: crypto.randomUUID(),
      socket: server,
      role: this.assignRole(),
      room,
      joinedAt: Date.now(),
      lastSeen: Date.now()
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
      players: this.players()
    });
    this.broadcastPresence();

    return new Response(null, {
      status: 101,
      webSocket: client
    } as ResponseInit & { webSocket: WebSocket });
  }

  private assignRole(): PlayerRole {
    for (const role of ACTIVE_ROLES) {
      if (this.isRoleFree(role)) {
        return role;
      }
    }

    return "spectator";
  }

  private isRoleFree(role: "fire" | "water"): boolean {
    for (const session of this.sessions.values()) {
      if (session.role === role && session.socket.readyState === WebSocket.OPEN) {
        return false;
      }
    }

    return true;
  }

  private handleMessage(
    session: { id: string; socket: WebSocket; role: PlayerRole; lastSeen: number },
    event: MessageEvent
  ): void {
    session.lastSeen = Date.now();

    let message: Record<string, unknown>;
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
    if (input) {
      this.broadcast(input, session.id);
    }
  }

  private validatedInput(
    session: { id: string; socket: WebSocket; role: PlayerRole },
    message: Record<string, unknown>
  ): Record<string, unknown> | null {
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

    if (typeof message.code !== "string" || !ROLE_KEYMAP[session.role].has(message.code)) {
      this.send(session, { type: "error", code: "bad_key", message: "Key is not allowed for assigned role." });
      return null;
    }

    return {
      type: "input",
      action: message.action,
      code: message.code,
      key: typeof message.key === "string" ? message.key : message.code,
      role: session.role,
      seq: typeof message.seq === "number" && Number.isFinite(message.seq) ? message.seq : 0,
      t: typeof message.t === "number" && Number.isFinite(message.t) ? message.t : Date.now(),
      sessionId: session.id
    };
  }

  private send(session: { socket: WebSocket }, message: Record<string, unknown>): void {
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify(message));
    }
  }

  private broadcast(message: Record<string, unknown>, exceptSessionId = ""): void {
    const text = JSON.stringify(message);

    for (const session of this.sessions.values()) {
      if (session.id === exceptSessionId) continue;
      if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(text);
      }
    }
  }

  private broadcastPresence(): void {
    this.broadcast({
      type: "presence",
      players: this.players()
    });
  }

  private players(): Array<{ id: string; role: PlayerRole; joinedAt: number; lastSeen: number }> {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      role: session.role,
      joinedAt: session.joinedAt,
      lastSeen: session.lastSeen
    }));
  }

  private removeSession(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      this.broadcastPresence();
    }
  }
}

function sanitizeRoom(value: string | null): string {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}
