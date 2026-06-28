const ROLE_KEYMAP = {
  fire: new Set(["ArrowLeft", "ArrowRight", "ArrowUp"]),
  water: new Set(["KeyA", "KeyD", "KeyW"]),
};

const ROLE_METADATA = {
  fire: { slot: "host", character: "fireboy" },
  water: { slot: "joiner", character: "watergirl" },
  spectator: { slot: "spectator", character: "spectator" },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/") {
      return new Response(
        [
          "Fireboy & Watergirl multiplayer API",
          "",
          "WebSocket endpoint:",
          "/room?room=<roomId>&preferredRole=fire|water",
        ].join("\n"),
        {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }
      );
    }

    if (url.pathname !== "/room" && url.pathname !== "/api/room") {
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
    this.gameStarted = false;
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

    this.dropClosedSessions();

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
      lastState: null,
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
      players: this.players(),
    });
    this.sendSnapshotsTo(session);
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  assignRole(preferredRole) {
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
          t: Date.now(),
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

  validatedInput(session, message) {
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
        x: finiteNumberOrNull(message.velocity?.x),
        y: finiteNumberOrNull(message.velocity?.y),
      },
      direction: sanitizeToken(message.direction, directionFromHeld(session.role, heldCodes)),
      actionState: sanitizeToken(message.actionState, actionStateFromHeld(session.role, heldCodes)),
      seq: numericOrZero(message.seq),
      timestamp: t,
      t,
      serverT: Date.now(),
    };
  }

  validatedState(session, message) {
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
        x: finiteNumberOrNull(message.velocity?.x) ?? vx,
        y: finiteNumberOrNull(message.velocity?.y) ?? vy,
      },
      direction: sanitizeToken(message.direction, directionFromHeld(session.role, heldCodes)),
      actionState: sanitizeToken(message.actionState, actionStateFromHeld(session.role, heldCodes)),
      seq: numericOrZero(message.seq),
      inputSeq: numericOrZero(message.inputSeq),
      timestamp: numericOrNow(message.timestamp ?? message.t),
      t,
      serverT: Date.now(),
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
      gameStarted: this.gameStarted,
      players: this.players(),
    });
  }

  sendSnapshotsTo(session) {
    for (const peer of this.sessions.values()) {
      if (peer.id !== session.id && peer.lastState) {
        this.send(session, peer.lastState);
      }
    }
  }

  broadcastSnapshots() {
    for (const session of this.sessions.values()) {
      if (session.lastState) {
        this.broadcast(session.lastState, session.id);
      }
    }
  }

  players() {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      role: session.role,
      slot: roleSlot(session.role),
      character: roleCharacter(session.role),
      joinedAt: session.joinedAt,
      lastSeen: session.lastSeen,
    }));
  }

  removeSession(sessionId) {
    if (this.sessions.delete(sessionId)) {
      this.broadcastPresence();
    }
  }

  dropClosedSessions() {
    for (const session of this.sessions.values()) {
      if (session.socket.readyState !== WebSocket.OPEN) {
        this.sessions.delete(session.id);
      }
    }
  }

  startGame(session) {
    if (session.role !== "fire") {
      this.send(session, { type: "error", code: "not_host", message: "Only Fireboy host can start the room." });
      return;
    }

    if (!this.gameStarted) {
      this.gameStarted = true;
    }

    this.broadcast({
      type: "room_state",
      gameStarted: this.gameStarted,
    });
    this.broadcastPresence();
    this.broadcastSnapshots();
  }
}

function normalizeRole(value) {
  return value === "fire" || value === "water" ? value : "";
}

function sanitizeRoom(value) {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}

function isActiveRole(role) {
  return role === "fire" || role === "water";
}

function roleSlot(role) {
  return ROLE_METADATA[role].slot;
}

function roleCharacter(role) {
  return ROLE_METADATA[role].character;
}

function numericOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numericOrNow(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sanitizeToken(value, fallback) {
  if (typeof value !== "string") return fallback;
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || fallback;
}

function sanitizeNullableToken(value) {
  if (typeof value !== "string") return null;
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || null;
}

function validatedHeldCodes(role, message) {
  const allowedCodes = ROLE_KEYMAP[role];
  const rawHeldCodes = Array.isArray(message.heldCodes)
    ? message.heldCodes
    : Array.isArray(message.held)
      ? message.held
      : [];

  return rawHeldCodes
    .filter((code) => typeof code === "string" && allowedCodes.has(code))
    .slice(0, allowedCodes.size);
}

function directionFromHeld(role, heldCodes) {
  if (role === "fire") {
    if (heldCodes.includes("ArrowLeft")) return "left";
    if (heldCodes.includes("ArrowRight")) return "right";
  }

  if (heldCodes.includes("KeyA")) return "left";
  if (heldCodes.includes("KeyD")) return "right";
  return "idle";
}

function actionStateFromHeld(role, heldCodes) {
  if ((role === "fire" && heldCodes.includes("ArrowUp")) || (role === "water" && heldCodes.includes("KeyW"))) {
    return "jump";
  }

  return directionFromHeld(role, heldCodes) === "idle" ? "idle" : "move";
}
