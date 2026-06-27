const ROLE_KEYMAP = {
  fire: new Set(["ArrowLeft", "ArrowRight", "ArrowUp"]),
  water: new Set(["KeyA", "KeyD", "KeyW"])
};

type PlayerRole = "fire" | "water" | "spectator";

type Env = {
  ROOMS: DurableObjectNamespace;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_REDIRECT_URI?: string;
};

const DEFAULT_DISCORD_CLIENT_ID = "1520427674860912660";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/api/health") {
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

    if (url.pathname === "/api/auth/discord/token" || url.pathname === "/auth/discord/token") {
      return exchangeDiscordCode(request, env);
    }

    if (url.pathname === "/room" || url.pathname === "/api/room") {
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

async function exchangeDiscordCode(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (!env.DISCORD_CLIENT_SECRET) {
    return jsonResponse({ error: "discord_secret_not_configured" }, 500);
  }

  let body: { code?: unknown };
  try {
    body = (await request.json()) as { code?: unknown };
  } catch {
    return jsonResponse({ error: "bad_json" }, 400);
  }

  if (typeof body.code !== "string" || !body.code) {
    return jsonResponse({ error: "missing_code" }, 400);
  }

  const form = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID || DEFAULT_DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code: body.code
  });

  // Discord Embedded App SDK authorization codes are exchanged server-side so the client secret never ships to the Activity iframe.
  if (env.DISCORD_REDIRECT_URI) {
    form.set("redirect_uri", env.DISCORD_REDIRECT_URI);
  }

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const tokenText = await tokenResponse.text();
  return new Response(tokenText, {
    status: tokenResponse.status,
    headers: {
      "content-type": tokenResponse.headers.get("content-type") || "application/json; charset=utf-8"
    }
  });
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

export class MultiplayerRoom {
  private gameStarted = false;
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
      gameStarted: this.gameStarted,
      players: this.players()
    });
    this.broadcastPresence();

    return new Response(null, {
      status: 101,
      webSocket: client
    } as ResponseInit & { webSocket: WebSocket });
  }

  private assignRole(): PlayerRole {
    if (this.isRoleFree("fire")) {
      return "fire";
    }

    if (this.gameStarted && this.isRoleFree("water")) {
      return "water";
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

    if (message.type === "game_start") {
      this.startGame(session);
      return;
    }

    if (message.type === "pointer") {
      const pointer = this.validatedPointer(session, message);
      if (pointer) {
        this.broadcast(pointer, session.id);
      }
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

  private validatedPointer(
    session: { id: string; socket: WebSocket; role: PlayerRole },
    message: Record<string, unknown>
  ): Record<string, unknown> | null {
    if (session.role !== "fire") {
      this.send(session, { type: "error", code: "not_host", message: "Only the host can relay menu pointer events." });
      return null;
    }

    if (message.action !== "pointerdown" && message.action !== "pointerup") {
      this.send(session, { type: "error", code: "bad_pointer_action", message: "Pointer action must be pointerdown or pointerup." });
      return null;
    }

    if (typeof message.x !== "number" || !Number.isFinite(message.x) || typeof message.y !== "number" || !Number.isFinite(message.y)) {
      this.send(session, { type: "error", code: "bad_pointer_position", message: "Pointer position must be finite normalized numbers." });
      return null;
    }

    return {
      type: "pointer",
      action: message.action,
      x: clamp(message.x, 0, 1),
      y: clamp(message.y, 0, 1),
      button: typeof message.button === "number" && Number.isFinite(message.button) ? message.button : 0,
      buttons: typeof message.buttons === "number" && Number.isFinite(message.buttons) ? message.buttons : 0,
      pointerId: typeof message.pointerId === "number" && Number.isFinite(message.pointerId) ? message.pointerId : 1,
      pointerType: typeof message.pointerType === "string" ? message.pointerType.slice(0, 24) : "mouse",
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
      gameStarted: this.gameStarted,
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
      if (this.gameStarted && this.isRoleFree("water")) {
        this.promoteNextSpectatorToWater();
      }
      this.broadcastPresence();
    }
  }

  private startGame(session: { id: string; socket: WebSocket; role: PlayerRole }): void {
    if (session.role !== "fire") {
      this.send(session, { type: "error", code: "not_host", message: "Only the host can start the room." });
      return;
    }

    if (!this.gameStarted) {
      this.gameStarted = true;
      this.promoteNextSpectatorToWater();
    }

    this.broadcast({
      type: "room_state",
      gameStarted: this.gameStarted
    });
    this.broadcastPresence();
  }

  private promoteNextSpectatorToWater(): void {
    if (!this.isRoleFree("water")) return;

    const spectator = Array.from(this.sessions.values())
      .filter((session) => session.role === "spectator" && session.socket.readyState === WebSocket.OPEN)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];

    if (!spectator) return;
    spectator.role = "water";
    this.send(spectator, {
      type: "role",
      role: spectator.role,
      gameStarted: this.gameStarted,
      players: this.players()
    });
  }
}

function sanitizeRoom(value: string | null): string {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
