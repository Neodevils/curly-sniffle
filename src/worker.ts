const ROLE_KEYMAP = {
  fire: new Set(["ArrowLeft", "ArrowRight", "ArrowUp"]),
  water: new Set(["KeyA", "KeyD", "KeyW"])
};

type PlayerRole = "fire" | "water" | "spectator";

type Session = {
  id: string;
  socket: WebSocket;
  role: PlayerRole;
  room: string;
  joinedAt: number;
  lastSeen: number;
};

type Env = {
  ROOMS: DurableObjectNamespace;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
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

  let body: { code?: unknown; redirect_uri?: unknown };
  try {
    body = (await request.json()) as { code?: unknown; redirect_uri?: unknown };
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

  // Discord Embedded App SDK authorization codes are exchanged without redirect_uri.
  // Only include it for an explicit redirect-based flow where the client also sent the same URI.
  if (typeof body.redirect_uri === "string" && body.redirect_uri) {
    form.set("redirect_uri", body.redirect_uri);
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
  private sessions = new Map<string, Session>();

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

    this.dropClosedSessions();

    const preferredRole = normalizeRole(url.searchParams.get("preferredRole"));
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const session: Session = {
      id: crypto.randomUUID(),
      socket: server,
      role: this.assignRole(preferredRole),
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

  private assignRole(preferredRole: "fire" | "water" | ""): PlayerRole {
    if (this.isRoleFree("fire")) {
      return "fire";
    }

    if (preferredRole === "water" && this.isRoleFree("water")) {
      return "water";
    }

    if (this.isRoleFree("water")) {
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

  private handleMessage(session: Session, event: MessageEvent): void {
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

    if (message.type === "input") {
      const input = this.validatedInput(session, message);
      if (input) {
        this.send(session, {
          type: "input_ack",
          action: input.action,
          code: input.code,
          role: input.role,
          seq: input.seq,
          t: Date.now()
        });
        this.broadcast(input, session.id);
      }
      return;
    }

    if (message.type === "state" || message.type === "frame") {
      const state = this.validatedState(session, message);
      if (state) {
        this.broadcast(state, session.id);
      }
      return;
    }

    if (message.type === "pointer") {
      return;
    }

    this.send(session, { type: "error", code: "bad_type", message: "Unsupported message type." });
  }

  private validatedInput(session: Session, message: Record<string, unknown>): Record<string, unknown> | null {
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
      sessionId: session.id,
      serverT: Date.now()
    };
  }

  private validatedState(session: Session, message: Record<string, unknown>): Record<string, unknown> | null {
    if (session.role !== "fire" && session.role !== "water") {
      return null;
    }

    if (message.role !== session.role) {
      return null;
    }

    const allowedCodes = ROLE_KEYMAP[session.role];
    const rawHeldCodes = Array.isArray(message.heldCodes)
      ? message.heldCodes
      : Array.isArray(message.held)
        ? message.held
        : [];
    const heldCodes = rawHeldCodes
      .filter((code): code is string => typeof code === "string" && allowedCodes.has(code))
      .slice(0, allowedCodes.size);

    return {
      type: "state",
      role: session.role,
      heldCodes,
      seq: typeof message.seq === "number" && Number.isFinite(message.seq) ? message.seq : 0,
      inputSeq: typeof message.inputSeq === "number" && Number.isFinite(message.inputSeq) ? message.inputSeq : 0,
      t: typeof message.t === "number" && Number.isFinite(message.t) ? message.t : Date.now(),
      sessionId: session.id,
      serverT: Date.now()
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

  private players(): Array<{ id: string; role: PlayerRole; slot: "host" | "joiner" | "spectator"; joinedAt: number; lastSeen: number }> {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      role: session.role,
      slot: session.role === "fire" ? "host" : session.role === "water" ? "joiner" : "spectator",
      joinedAt: session.joinedAt,
      lastSeen: session.lastSeen
    }));
  }

  private removeSession(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      this.broadcastPresence();
    }
  }

  private dropClosedSessions(): void {
    for (const session of this.sessions.values()) {
      if (session.socket.readyState !== WebSocket.OPEN) {
        this.sessions.delete(session.id);
      }
    }
  }

  private startGame(session: Session): void {
    if (session.role !== "fire") {
      this.send(session, { type: "error", code: "not_host", message: "Only Fireboy host can start the room." });
      return;
    }

    if (!this.gameStarted) {
      this.gameStarted = true;
    }

    this.broadcast({
      type: "room_state",
      gameStarted: this.gameStarted
    });
    this.broadcastPresence();
  }
}

function normalizeRole(value: string | null): "fire" | "water" | "" {
  return value === "fire" || value === "water" ? value : "";
}

function sanitizeRoom(value: string | null): string {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}
