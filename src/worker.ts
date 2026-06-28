const ROLE_KEYMAP = {
  fire: new Set(["ArrowLeft", "ArrowRight", "ArrowUp"]),
  water: new Set(["KeyA", "KeyD", "KeyW"])
};

type PlayerRole = "fire" | "water" | "spectator";
type ActiveRole = "fire" | "water";
type PlayerSlot = "host" | "joiner" | "spectator";

type RelayState = {
  type: "state";
  room: string;
  playerId: string;
  sessionId: string;
  slot: PlayerSlot;
  role: ActiveRole;
  character: "fireboy" | "watergirl";
  heldCodes: string[];
  x: number | null;
  y: number | null;
  vx: number | null;
  vy: number | null;
  pixelX: number | null;
  pixelY: number | null;
  stageX: number | null;
  stageY: number | null;
  swfTimestamp: number | null;
  level: number | null;
  levelMode: string | null;
  velocity: { x: number | null; y: number | null };
  direction: string;
  actionState: string;
  seq: number;
  inputSeq: number;
  timestamp: number;
  t: number;
  serverT: number;
};

type Session = {
  id: string;
  socket: WebSocket;
  role: PlayerRole;
  room: string;
  joinedAt: number;
  lastSeen: number;
  lastState?: RelayState;
};

type Env = {
  ROOMS: DurableObjectNamespace;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
};

const DEFAULT_DISCORD_CLIENT_ID = "1520427674860912660";
const ROLE_METADATA = {
  fire: { slot: "host", character: "fireboy" },
  water: { slot: "joiner", character: "watergirl" },
  spectator: { slot: "spectator", character: "spectator" }
} as const;

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
      slot: roleSlot(session.role),
      character: roleCharacter(session.role),
      room,
      gameStarted: this.gameStarted,
      players: this.players()
    });
    this.sendSnapshotsTo(session);
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
          slot: input.slot,
          character: input.character,
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
        session.lastState = state;
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
    if (!isActiveRole(session.role)) {
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

    const heldCodes = validatedHeldCodes(session.role, message);
    const seq = numericOrZero(message.seq);
    const t = numericOrNow(message.t);

    return {
      type: "input",
      action: message.action,
      code: message.code,
      key: typeof message.key === "string" ? message.key : message.code,
      room: session.room,
      playerId: session.id,
      sessionId: session.id,
      slot: roleSlot(session.role),
      role: session.role,
      character: roleCharacter(session.role),
      heldCodes,
      x: finiteNumberOrNull(message.x),
      y: finiteNumberOrNull(message.y),
      vx: finiteNumberOrNull(message.vx),
      vy: finiteNumberOrNull(message.vy),
      pixelX: finiteNumberOrNull(message.pixelX),
      pixelY: finiteNumberOrNull(message.pixelY),
      stageX: finiteNumberOrNull(message.stageX),
      stageY: finiteNumberOrNull(message.stageY),
      swfTimestamp: finiteNumberOrNull(message.swfTimestamp),
      level: finiteNumberOrNull(message.level),
      levelMode: sanitizeNullableToken(message.levelMode),
      velocity: {
        x: finiteNumberOrNull((message.velocity as Record<string, unknown> | undefined)?.x),
        y: finiteNumberOrNull((message.velocity as Record<string, unknown> | undefined)?.y)
      },
      direction: sanitizeToken(message.direction, directionFromHeld(session.role, heldCodes)),
      actionState: sanitizeToken(message.actionState, actionStateFromHeld(session.role, heldCodes)),
      seq,
      timestamp: t,
      t,
      serverT: Date.now()
    };
  }

  private validatedState(session: Session, message: Record<string, unknown>): RelayState | null {
    if (!isActiveRole(session.role)) {
      return null;
    }

    if (message.role !== session.role) {
      return null;
    }

    const heldCodes = validatedHeldCodes(session.role, message);
    const x = finiteNumberOrNull(message.x);
    const y = finiteNumberOrNull(message.y);
    const vx = finiteNumberOrNull(message.vx);
    const vy = finiteNumberOrNull(message.vy);
    const pixelX = finiteNumberOrNull(message.pixelX);
    const pixelY = finiteNumberOrNull(message.pixelY);
    const stageX = finiteNumberOrNull(message.stageX);
    const stageY = finiteNumberOrNull(message.stageY);
    const swfTimestamp = finiteNumberOrNull(message.swfTimestamp);
    const level = finiteNumberOrNull(message.level);
    const t = numericOrNow(message.t);

    return {
      type: "state",
      room: session.room,
      playerId: session.id,
      sessionId: session.id,
      slot: roleSlot(session.role),
      role: session.role,
      character: roleCharacter(session.role),
      heldCodes,
      x,
      y,
      vx,
      vy,
      pixelX,
      pixelY,
      stageX,
      stageY,
      swfTimestamp,
      level,
      levelMode: sanitizeNullableToken(message.levelMode),
      velocity: {
        x: finiteNumberOrNull((message.velocity as Record<string, unknown> | undefined)?.x) ?? vx,
        y: finiteNumberOrNull((message.velocity as Record<string, unknown> | undefined)?.y) ?? vy
      },
      direction: sanitizeToken(message.direction, directionFromHeld(session.role, heldCodes)),
      actionState: sanitizeToken(message.actionState, actionStateFromHeld(session.role, heldCodes)),
      seq: numericOrZero(message.seq),
      inputSeq: numericOrZero(message.inputSeq),
      timestamp: numericOrNow(message.timestamp ?? message.t),
      t,
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

  private sendSnapshotsTo(session: Session): void {
    for (const peer of this.sessions.values()) {
      if (peer.id !== session.id && peer.lastState) {
        this.send(session, peer.lastState);
      }
    }
  }

  private broadcastSnapshots(): void {
    for (const session of this.sessions.values()) {
      if (session.lastState) {
        this.broadcast(session.lastState, session.id);
      }
    }
  }

  private players(): Array<{
    id: string;
    role: PlayerRole;
    slot: PlayerSlot;
    character: string;
    joinedAt: number;
    lastSeen: number;
  }> {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      role: session.role,
      slot: roleSlot(session.role),
      character: roleCharacter(session.role),
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
    this.broadcastSnapshots();
  }
}

function normalizeRole(value: string | null): "fire" | "water" | "" {
  return value === "fire" || value === "water" ? value : "";
}

function sanitizeRoom(value: string | null): string {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}

function isActiveRole(role: PlayerRole): role is ActiveRole {
  return role === "fire" || role === "water";
}

function roleSlot(role: PlayerRole): PlayerSlot {
  return ROLE_METADATA[role].slot;
}

function roleCharacter(role: ActiveRole): "fireboy" | "watergirl";
function roleCharacter(role: PlayerRole): string;
function roleCharacter(role: PlayerRole): string {
  return ROLE_METADATA[role].character;
}

function numericOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numericOrNow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sanitizeToken(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || fallback;
}

function sanitizeNullableToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || null;
}

function validatedHeldCodes(role: ActiveRole, message: Record<string, unknown>): string[] {
  const allowedCodes = ROLE_KEYMAP[role];
  const rawHeldCodes = Array.isArray(message.heldCodes)
    ? message.heldCodes
    : Array.isArray(message.held)
      ? message.held
      : [];

  return rawHeldCodes
    .filter((code): code is string => typeof code === "string" && allowedCodes.has(code))
    .slice(0, allowedCodes.size);
}

function directionFromHeld(role: ActiveRole, heldCodes: string[]): string {
  if (role === "fire") {
    if (heldCodes.includes("ArrowLeft")) return "left";
    if (heldCodes.includes("ArrowRight")) return "right";
  }

  if (heldCodes.includes("KeyA")) return "left";
  if (heldCodes.includes("KeyD")) return "right";
  return "idle";
}

function actionStateFromHeld(role: ActiveRole, heldCodes: string[]): string {
  if ((role === "fire" && heldCodes.includes("ArrowUp")) || (role === "water" && heldCodes.includes("KeyW"))) {
    return "jump";
  }

  return directionFromHeld(role, heldCodes) === "idle" ? "idle" : "move";
}
