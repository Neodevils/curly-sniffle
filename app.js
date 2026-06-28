      const assetUrl = (path) => new URL(path, document.baseURI).href;
      const FILE_PATH = assetUrl("./swf/game.swf");
      const DEBUG_MULTIPLAYER = false;
      const DISCORD_SDK_MODULE_URL = assetUrl("./vendor/discord-sdk.js");
      const DISCORD_READY_TIMEOUT_MS = 3500;
      const DISCORD_CLIENT_ID = "1520427674860912660";
      const MULTIPLAYER_SERVER_URL = "wss://fireboy-watergirl.neodevils-contact.workers.dev/room";
      const DISCORD_ACTIVITY_SERVER_URL = "/api/room";
      const DISCORD_AUTH_TOKEN_URL = "/api/auth/discord/token";
      const DISCORD_ACTIVITY_SCOPES = ["identify", "rpc.activities.write"];
      const ROLE_KEYMAP = {
        fire: {
          ArrowLeft: { key: "ArrowLeft", keyCode: 37 },
          ArrowRight: { key: "ArrowRight", keyCode: 39 },
          ArrowUp: { key: "ArrowUp", keyCode: 38 }
        },
        water: {
          KeyA: { key: "a", keyCode: 65 },
          KeyD: { key: "d", keyCode: 68 },
          KeyW: { key: "w", keyCode: 87 }
        }
      };
      const ROLE_METADATA = {
        fire: { slot: "host", character: "fireboy", label: "Host - Fireboy" },
        water: { slot: "joiner", character: "watergirl", label: "Joiner - Watergirl" },
        spectator: { slot: "spectator", character: "spectator", label: "Spectator" },
        "single-player": { slot: "local", character: "fireboy", label: "Single player" }
      };
      const TOUCH_CONTROL_CODES = {
        fire: { left: "ArrowLeft", right: "ArrowRight", jump: "ArrowUp" },
        water: { left: "KeyA", right: "KeyD", jump: "KeyW" }
      };
      const CONTROLLED_CODES = new Set(Object.values(ROLE_KEYMAP).flatMap((mapping) => Object.keys(mapping)));
      const KEY_CODE_TO_CODE = {
        37: "ArrowLeft",
        38: "ArrowUp",
        39: "ArrowRight",
        65: "KeyA",
        68: "KeyD",
        87: "KeyW"
      };
      const KEY_VALUE_TO_CODE = {
        ArrowLeft: "ArrowLeft",
        Left: "ArrowLeft",
        ArrowUp: "ArrowUp",
        Up: "ArrowUp",
        ArrowRight: "ArrowRight",
        Right: "ArrowRight",
        a: "KeyA",
        A: "KeyA",
        d: "KeyD",
        D: "KeyD",
        w: "KeyW",
        W: "KeyW"
      };
      const params = new URLSearchParams(window.location.search);
      const isDiscordActivity =
        window.location.hostname.endsWith(".discordsays.com") ||
        params.has("instance_id") ||
        params.has("frame_id") ||
        params.has("discord_proxy_ticket");
      const explicitRoomId = sanitizeRoom(params.get("room"));
      let roomId = explicitRoomId || makeRoomId();
      const preferredRole = normalizeRole(params.get("role"));
      const serverUrl = normalizeServerUrl(
        params.get("server") || (isDiscordActivity ? DISCORD_ACTIVITY_SERVER_URL : MULTIPLAYER_SERVER_URL)
      );
      const discordClientId = params.get("discordClientId") || params.get("client_id") || (isDiscordActivity ? DISCORD_CLIENT_ID : "");
      const debugMode = params.get("debug") === "1";
      const target = document.querySelector("#player");
      const debugOverlay = document.querySelector("#debugOverlay");
      const fullscreenButton = document.querySelector("#fullscreenButton");
      const copyInviteButton = document.querySelector("#copyInviteButton");
      const reconnectButton = document.querySelector("#reconnectButton");
      const setupMessage = document.querySelector("#setupMessage");
      const statusDot = document.querySelector("#statusDot");
      const statusText = document.querySelector("#statusText");
      const roomText = document.querySelector("#roomText");
      const roleText = document.querySelector("#roleText");
      const compactRoleText = document.querySelector("#compactRoleText");
      const roomBadgeId = document.querySelector("#roomBadgeId");
      const roomBadgeStatus = document.querySelector("#roomBadgeStatus");
      const roomBadgeRole = document.querySelector("#roomBadgeRole");
      const roomBadgePlayers = document.querySelector("#roomBadgePlayers");
      const roomBadgeBridge = document.querySelector("#roomBadgeBridge");
      const discordText = document.querySelector("#discordText");
      const playersText = document.querySelector("#playersText");
      const touchControls = document.querySelector("#touchControls");
      const padButtons = Array.from(document.querySelectorAll(".pad-button"));
      const deviceType = getDeviceType();
      const shouldUseTouchControls = shouldEnableTouchControls(deviceType);

      let rufflePlayer = null;
      let socket = null;
      let heartbeatTimer = 0;
      let stateTimer = 0;
      let swfPositionPollTimer = 0;
      let reconnectTimer = 0;
      let sessionId = "";
      let assignedRole = "single-player";
      let seq = 0;
      let stateSeq = 0;
      let discordSdk = null;
      let discordReady = false;
      let discordAuthenticated = false;
      let discordParticipants = 0;
      let roomGameStarted = false;
      let gameStartSent = false;
      let currentPlayers = [];
      let latestSwfState = null;
      let latestSwfPositions = { fireboy: null, watergirl: null };
      let lastPositionStateSentAt = 0;
      let swfReadBridgeReady = false;
      let swfWriteBridgeReady = false;
      let swfPositionBridgeErrorLogged = false;
      let remotePositionBridgeErrorLogged = false;
      const POSITION_STATE_INTERVAL_MS = 33;
      const localHeldCodes = new Set();
      const remoteHeldCodes = new Set();
      const lastRemoteSeqByRole = new Map();
      const lastRemoteStateSeqByRole = new Map();
      const touchHeld = new Map();
      const keyboardListenerTargets = new Set();

      debugOverlay?.classList.toggle("is-hidden", !debugMode);
      roomText.textContent = roomId;
      updateRoomBadge();
      syncRoomUrl();

      function debugLog(...args) {
        if (DEBUG_MULTIPLAYER || debugMode) {
          console.debug("[multiplayer]", ...args);
        }
      }

      function isAbortError(error) {
        return window.__fireWaterIsAbortError?.(error) || false;
      }

      function runBackgroundTask(promise, label) {
        Promise.resolve(promise).catch((error) => {
          if (!isAbortError(error)) {
            console.warn(`${label} failed:`, error);
          }
          debugLog(label, error);
        });
      }

      function getDeviceType() {
        const userAgent = navigator.userAgent.toLowerCase();
        const maxTouchPoints = navigator.maxTouchPoints || 0;
        const isIPadOS = maxTouchPoints > 1 && userAgent.includes("macintosh");
        const isAndroid = userAgent.includes("android");
        const isPhone = /iphone|ipod|windows phone/.test(userAgent) || (isAndroid && userAgent.includes("mobile"));
        const isTablet =
          isIPadOS ||
          /ipad|tablet|playbook|silk|kindle/.test(userAgent) ||
          (isAndroid && !userAgent.includes("mobile"));

        if (isTablet) return "tablet";
        if (isPhone) return "phone";
        return "desktop";
      }

      function shouldEnableTouchControls(type) {
        const hasTouch = (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window;
        const hasCoarsePointer = window.matchMedia?.("(any-pointer: coarse)")?.matches || false;
        return (type === "phone" || type === "tablet") && (hasTouch || hasCoarsePointer);
      }

      function sanitizeRoom(value) {
        if (!value) return "";
        return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      }

      function makeRoomId() {
        const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
      }

      function normalizeRole(value) {
        return value === "fire" || value === "water" ? value : "";
      }

      function normalizeServerUrl(value) {
        if (!value) return "";
        const trimmed = value.trim();
        if (!trimmed) return "";
        if (trimmed.startsWith("/")) return new URL(trimmed, window.location.href).toString().replace(/^http/i, "ws");
        if (/^wss?:\/\//i.test(trimmed)) return trimmed;
        if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http/i, "ws");
        return `wss://${trimmed}`;
      }

      function syncRoomUrl() {
        if (params.get("room") === roomId) return;
        params.set("room", roomId);
        const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
        window.history.replaceState(null, "", nextUrl);
      }

      function inviteUrl() {
        const invite = new URL(window.location.href);
        invite.searchParams.set("room", roomId);
        if (serverUrl) {
          invite.searchParams.set("server", serverUrl);
        }
        invite.searchParams.delete("role");
        return invite.toString();
      }

      function websocketUrl() {
        if (!serverUrl) return "";
        const url = new URL(serverUrl);
        url.searchParams.set("room", roomId);
        if (preferredRole) {
          url.searchParams.set("preferredRole", preferredRole);
        }
        return url.toString();
      }

      function setStatus(state, text) {
        statusDot.className = `dot ${state}`;
        statusText.textContent = text;
        updateRoomBadge();
      }

      function setPlayers(players = []) {
        currentPlayers = players;
        const active = players.filter((player) => player.role === "fire" || player.role === "water");
        const discordSuffix = discordParticipants ? `, ${discordParticipants} Discord` : "";
        const activeLabels = active.map((player) => roleLabel(player.role)).join(", ");
        const spectatorCount = Math.max(0, players.length - active.length);
        playersText.textContent = `${active.length}/2 active${activeLabels ? `: ${activeLabels}` : ""}, ${spectatorCount} spectator${discordSuffix}`;
        updateRoomBadge();
      }

      function updateRole(role) {
        if (assignedRole !== role) {
          releaseLocalHeldKeys();
          releaseTouchHeldKeys();
        }
        assignedRole = role || "single-player";
        roleText.textContent = roleLabel(assignedRole);
        compactRoleText.textContent = roleLabel(assignedRole);
        updateRoomBadge();
        updateTouchControls();
        sendLocalState("role");
      }

      function updateRoomBadge() {
        const activePlayers = currentPlayers.filter((player) => player.role === "fire" || player.role === "water");
        roomBadgeId.textContent = roomId || "-";
        roomBadgeStatus.textContent = statusText?.textContent || "Single player";
        roomBadgeRole.textContent = roleLabel(assignedRole);
        roomBadgePlayers.textContent = `${activePlayers.length}/2 active`;
        roomBadgeBridge.textContent = swfBridgeLabel();
      }

      function swfBridgeLabel() {
        if (swfReadBridgeReady && swfWriteBridgeReady) return "read/write ok";
        if (swfReadBridgeReady) return "read ok";
        if (swfWriteBridgeReady) return "write ok";
        return "Bridge waiting";
      }

      function roleLabel(role) {
        return ROLE_METADATA[role]?.label || ROLE_METADATA["single-player"].label;
      }

      function roleSlot(role) {
        return ROLE_METADATA[role]?.slot || ROLE_METADATA["single-player"].slot;
      }

      function roleCharacter(role) {
        return ROLE_METADATA[role]?.character || ROLE_METADATA["single-player"].character;
      }

      function localControlRole() {
        if (assignedRole === "water") return "water";
        return "fire";
      }

      function isHostRole() {
        return assignedRole === "fire" || assignedRole === "single-player";
      }

      function notifyHostGameStart(event) {
        if (!event.isTrusted || !serverUrl || !isHostRole() || gameStartSent) return;
        gameStartSent = true;
        sendRaw({ type: "game_start", t: Date.now() });
      }

      function updateTouchControls() {
        touchControls?.classList.toggle("is-hidden", !shouldUseTouchControls);

        if (!shouldUseTouchControls) {
          return;
        }

        touchControls?.classList.toggle("is-hidden", assignedRole === "spectator");
      }

      async function boot() {
        const api = window.RufflePlayer?.newest?.();

        if (!api || !target) {
          console.error("Ruffle or player container was not found.");
          return;
        }

        const player = api.createPlayer();
        player.tabIndex = 0;
        target.appendChild(player);
        rufflePlayer = player;

        await player.ruffle().load(FILE_PATH);
        startSwfPositionPolling();
        installKeyboardListeners();
        focusRufflePlayer();
      }

      function focusRufflePlayer() {
        requestAnimationFrame(() => {
          const focusTarget = rufflePlayer?.shadowRoot?.querySelector("canvas") || rufflePlayer;
          focusTarget?.focus?.({ preventScroll: true });
        });
      }

      function requestKeyboardCapture() {
        if (!isDiscordActivity || !navigator.keyboard?.lock) return;
        navigator.keyboard.lock(Array.from(CONTROLLED_CODES)).catch((error) => {
          debugLog("keyboard lock failed", error);
        });
      }

      function ruffleEventTargets() {
        const targets = [rufflePlayer];
        if (rufflePlayer?.shadowRoot) targets.push(rufflePlayer.shadowRoot);
        const shadowCanvas = rufflePlayer?.shadowRoot?.querySelector("canvas");
        if (shadowCanvas) targets.push(shadowCanvas);
        if (target) targets.push(target);
        if (document.activeElement) targets.push(document.activeElement);
        targets.push(document, window);
        return Array.from(new Set(targets.filter(Boolean)));
      }

      function installKeyboardListeners() {
        for (const listenerTarget of ruffleEventTargets()) {
          if (keyboardListenerTargets.has(listenerTarget) || !listenerTarget.addEventListener) continue;
          keyboardListenerTargets.add(listenerTarget);
          listenerTarget.addEventListener("keydown", handleLocalKey, true);
          listenerTarget.addEventListener("keyup", handleLocalKey, true);
        }
      }

      function normalizeEventCode(event) {
        if (event.code && CONTROLLED_CODES.has(event.code)) {
          return event.code;
        }

        if (event.key && KEY_VALUE_TO_CODE[event.key]) {
          return KEY_VALUE_TO_CODE[event.key];
        }

        const legacyKeyCode = event.keyCode || event.which;
        return KEY_CODE_TO_CODE[legacyKeyCode] || event.code || "";
      }

      async function enterFullscreen() {
        const element = document.documentElement;

        if (document.fullscreenElement) {
          await document.exitFullscreen();
          return;
        }

        if (element.requestFullscreen) {
          await element.requestFullscreen();
        }
      }

      function connect() {
        clearTimeout(reconnectTimer);
        clearInterval(heartbeatTimer);
        clearInterval(stateTimer);

        if (!serverUrl) {
          setupMessage.classList.remove("is-visible");
          reconnectButton.disabled = true;
          updateRole("single-player");
          setStatus("disconnected", "Single player");
          playersText.textContent = "-";
          return;
        }

        setupMessage.classList.remove("is-visible");
        reconnectButton.disabled = false;

        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.close(1000, "reconnect");
        }

        const url = websocketUrl();
        setStatus("", "Connecting");
        debugLog("connect", url);
        socket = new WebSocket(url);

        socket.addEventListener("open", () => {
          setStatus("connected", "Connected");
          requestKeyboardCapture();
          heartbeatTimer = window.setInterval(() => sendRaw({ type: "ping", t: Date.now() }), 15000);
          stateTimer = window.setInterval(() => sendLocalState("heartbeat"), 100);
          sendLocalState("open");
        });

        socket.addEventListener("message", (event) => {
          handleServerMessage(event.data);
        });

        socket.addEventListener("close", () => {
          clearInterval(heartbeatTimer);
          clearInterval(stateTimer);
          releaseRemoteHeldKeys();
          releaseTouchHeldKeys();
          setStatus("disconnected", "Disconnected");
          debugLog("socket closed");
          reconnectTimer = window.setTimeout(() => {
            if (serverUrl) connect();
          }, 2500);
        });

        socket.addEventListener("error", (error) => {
          setStatus("error", "Connection error");
          debugLog("socket error", error);
        });
      }

      function sendRaw(message) {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      }

      function handleServerMessage(raw) {
        let message = null;
        try {
          message = JSON.parse(raw);
        } catch (error) {
          debugLog("invalid server message", raw, error);
          return;
        }

        if (message.type === "welcome") {
          sessionId = message.sessionId || "";
          roomGameStarted = Boolean(message.gameStarted);
          updateRole(message.role);
          roomText.textContent = message.room || roomId;
          setPlayers(message.players || []);
          runBackgroundTask(updateDiscordActivityStatus(), "discord status update");
          focusRufflePlayer();
          sendLocalState("welcome");
          return;
        }

        if (message.type === "role") {
          roomGameStarted = Boolean(message.gameStarted);
          updateRole(message.role);
          setPlayers(message.players || currentPlayers);
          runBackgroundTask(updateDiscordActivityStatus(), "discord status update");
          focusRufflePlayer();
          sendLocalState("role");
          return;
        }

        if (message.type === "room_state") {
          roomGameStarted = Boolean(message.gameStarted);
          runBackgroundTask(updateDiscordActivityStatus(), "discord status update");
          sendLocalState("room_state");
          return;
        }

        if (message.type === "presence") {
          roomGameStarted = Boolean(message.gameStarted);
          setPlayers(message.players || []);
          runBackgroundTask(updateDiscordActivityStatus(), "discord status update");
          sendLocalState("presence");
          return;
        }

        if (message.type === "pong") {
          debugLog("pong", message.t);
          return;
        }

        if (message.type === "input_ack") {
          debugLog("input ack", message.role, message.action, message.code, message.seq);
          return;
        }

        if (message.type === "input" && message.sessionId !== sessionId) {
          dispatchRemoteInput(message);
          return;
        }

        if ((message.type === "state" || message.type === "frame") && message.sessionId !== sessionId) {
          applyRemoteState(message);
          return;
        }

        if (message.type === "pointer") return;
      }

      function canSendCode(code) {
        return assignedRole === "fire" || assignedRole === "water"
          ? Boolean(ROLE_KEYMAP[assignedRole]?.[code])
          : false;
      }

      function shouldBlockLocalCode(code) {
        if (!serverUrl || assignedRole === "single-player") return false;
        if (!CONTROLLED_CODES.has(code)) return false;
        return !canSendCode(code);
      }

      function isRemoteRole(role) {
        if (role !== "fire" && role !== "water") return false;
        return assignedRole === "fire" || assignedRole === "water" ? role !== assignedRole : false;
      }

      function currentHeldCodesForRole(role) {
        const heldCodes = new Set();

        if (assignedRole === role) {
          for (const code of localHeldCodes) {
            if (ROLE_KEYMAP[role]?.[code]) {
              heldCodes.add(code);
            }
          }
        }

        for (const held of touchHeld.values()) {
          if (held.role === role && ROLE_KEYMAP[role]?.[held.code]) {
            heldCodes.add(held.code);
          }
        }

        return Array.from(heldCodes);
      }

      function movementDirection(role, heldCodes) {
        if (role === "fire") {
          if (heldCodes.includes("ArrowLeft")) return "left";
          if (heldCodes.includes("ArrowRight")) return "right";
        }

        if (role === "water") {
          if (heldCodes.includes("KeyA")) return "left";
          if (heldCodes.includes("KeyD")) return "right";
        }

        return "idle";
      }

      function movementAction(role, heldCodes) {
        const jumpCode = role === "water" ? "KeyW" : "ArrowUp";
        if (heldCodes.includes(jumpCode)) return "jump";
        if (movementDirection(role, heldCodes) !== "idle") return "move";
        return "idle";
      }

      function startSwfPositionPolling() {
        clearInterval(swfPositionPollTimer);
        swfPositionPollTimer = window.setInterval(pollSwfPositionState, POSITION_STATE_INTERVAL_MS);
        pollSwfPositionState();
      }

      function pollSwfPositionState() {
        const rawState = readSwfPositionState();
        const state = normalizeSwfPositionState(rawState);
        if (!state) return;

        latestSwfState = state;
        latestSwfPositions = {
          fireboy: state.fireboy || latestSwfPositions.fireboy,
          watergirl: state.watergirl || latestSwfPositions.watergirl
        };

        const localPosition = latestPositionForRole(assignedRole);
        const now = Date.now();
        if (
          state.active &&
          localPosition &&
          socket?.readyState === WebSocket.OPEN &&
          now - lastPositionStateSentAt >= POSITION_STATE_INTERVAL_MS
        ) {
          lastPositionStateSentAt = now;
          sendLocalState("position");
        }
      }

      function readSwfPositionState() {
        try {
          if (typeof rufflePlayer?.fireWaterGetState === "function") {
            const state = rufflePlayer.fireWaterGetState();
            if (!swfReadBridgeReady && state && typeof state === "object") {
              swfReadBridgeReady = true;
              updateRoomBadge();
            }
            return state;
          }

          const ruffleApi = rufflePlayer?.ruffle?.();
          if (typeof ruffleApi?.callExternalInterface === "function") {
            const state = ruffleApi.callExternalInterface("fireWaterGetState");
            if (!swfReadBridgeReady && state && typeof state === "object") {
              swfReadBridgeReady = true;
              updateRoomBadge();
            }
            return state;
          }
        } catch (error) {
          if (!swfPositionBridgeErrorLogged) {
            swfPositionBridgeErrorLogged = true;
            debugLog("SWF position bridge unavailable", error);
          }
        }

        return null;
      }

      function normalizeSwfPositionState(state) {
        if (!state || typeof state !== "object") return null;

        const timestamp = finiteNumberOrNull(state.timestamp);
        return {
          active: Boolean(state.active),
          level: finiteNumberOrNull(state.level),
          mode: typeof state.mode === "string" ? state.mode : null,
          timestamp,
          fireboy: normalizeSwfPlayerPosition(state.fireboy, "fireboy", timestamp),
          watergirl: normalizeSwfPlayerPosition(state.watergirl, "watergirl", timestamp)
        };
      }

      function normalizeSwfPlayerPosition(position, character, timestamp) {
        if (!position || typeof position !== "object") return null;
        const x = finiteNumberOrNull(position.x);
        const y = finiteNumberOrNull(position.y);
        if (x === null || y === null) return null;

        return {
          character,
          x,
          y,
          vx: finiteNumberOrNull(position.vx),
          vy: finiteNumberOrNull(position.vy),
          pixelX: finiteNumberOrNull(position.pixelX),
          pixelY: finiteNumberOrNull(position.pixelY),
          stageX: finiteNumberOrNull(position.stageX),
          stageY: finiteNumberOrNull(position.stageY),
          timestamp
        };
      }

      function latestPositionForRole(role) {
        return latestSwfPositions[roleCharacter(role)] || null;
      }

      function finiteNumberOrNull(value) {
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      }

      function buildMovementPayload(type, role, extra = {}) {
        const heldCodes = currentHeldCodesForRole(role);
        const latestPosition = latestPositionForRole(role);
        const now = Date.now();
        return {
          type,
          room: roomId,
          playerId: sessionId,
          sessionId,
          slot: roleSlot(role),
          role,
          character: roleCharacter(role),
          heldCodes,
          x: latestPosition?.x ?? null,
          y: latestPosition?.y ?? null,
          vx: latestPosition?.vx ?? null,
          vy: latestPosition?.vy ?? null,
          pixelX: latestPosition?.pixelX ?? null,
          pixelY: latestPosition?.pixelY ?? null,
          stageX: latestPosition?.stageX ?? null,
          stageY: latestPosition?.stageY ?? null,
          swfTimestamp: latestPosition?.timestamp ?? latestSwfState?.timestamp ?? null,
          level: latestSwfState?.level ?? null,
          levelMode: latestSwfState?.mode ?? null,
          velocity: { x: latestPosition?.vx ?? null, y: latestPosition?.vy ?? null },
          direction: movementDirection(role, heldCodes),
          actionState: movementAction(role, heldCodes),
          timestamp: now,
          t: now,
          ...extra
        };
      }

      function handleLocalKey(event) {
        if (!event.isTrusted) return;
        installKeyboardListeners();
        const code = normalizeEventCode(event);
        if (!code) return;

        if (shouldBlockLocalCode(code)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          debugLog("blocked local key", assignedRole, code);
          return;
        }

        if (!canSendCode(code)) return;

        event.preventDefault();

        if (event.type === "keydown") {
          if (event.repeat || localHeldCodes.has(code)) return;
          localHeldCodes.add(code);
        } else {
          if (!localHeldCodes.has(code)) return;
          localHeldCodes.delete(code);
        }

        sendInput(event.type, assignedRole, code);
      }

      function dispatchRemoteInput(message) {
        if (!isRemoteRole(message.role) || !ROLE_KEYMAP[message.role]?.[message.code]) {
          return;
        }

        const messageSeq = Number.isFinite(message.seq) ? message.seq : 0;
        const previousSeq = lastRemoteSeqByRole.get(message.role) || 0;
        if (messageSeq && messageSeq <= previousSeq) {
          return;
        }
        if (messageSeq) {
          lastRemoteSeqByRole.set(message.role, messageSeq);
        }

        applyRemotePosition(message);

        const keyInfo = ROLE_KEYMAP[message.role][message.code];
        debugLog("remote input", message.action, message.role, message.code);
        const remoteHeldKey = `${message.role}:${message.code}`;
        const wasHeld = remoteHeldCodes.has(remoteHeldKey);
        if (message.action === "keydown") {
          if (wasHeld) return;
          remoteHeldCodes.add(remoteHeldKey);
        } else {
          if (!wasHeld) return;
          remoteHeldCodes.delete(remoteHeldKey);
        }
        dispatchKeyboard(message.action, message.code, keyInfo);
        focusRufflePlayer();
      }

      function applyRemoteState(message) {
        if (!isRemoteRole(message.role)) return;

        const stateSeqValue = Number.isFinite(message.seq) ? message.seq : 0;
        const previousStateSeq = lastRemoteStateSeqByRole.get(message.role) || 0;
        if (stateSeqValue && stateSeqValue <= previousStateSeq) {
          return;
        }
        if (stateSeqValue) {
          lastRemoteStateSeqByRole.set(message.role, stateSeqValue);
        }

        applyRemotePosition(message);

        const allowedCodes = ROLE_KEYMAP[message.role] || {};
        const nextHeldCodes = new Set(
          Array.isArray(message.heldCodes)
            ? message.heldCodes.filter((code) => typeof code === "string" && allowedCodes[code])
            : []
        );

        for (const code of Object.keys(allowedCodes)) {
          const remoteHeldKey = `${message.role}:${code}`;
          const isHeld = remoteHeldCodes.has(remoteHeldKey);
          const shouldHold = nextHeldCodes.has(code);
          if (shouldHold && !isHeld) {
            remoteHeldCodes.add(remoteHeldKey);
            dispatchKeyboard("keydown", code, allowedCodes[code]);
          } else if (!shouldHold && isHeld) {
            remoteHeldCodes.delete(remoteHeldKey);
            dispatchKeyboard("keyup", code, allowedCodes[code]);
          }
        }
      }

      function applyRemotePosition(message) {
        if (!isRemoteRole(message.role)) return false;

        const x = finiteNumberOrNull(message.x);
        const y = finiteNumberOrNull(message.y);
        if (x === null || y === null) return false;

        const character = roleCharacter(message.role);
        const vx = finiteNumberOrNull(message.vx ?? message.velocity?.x) ?? 0;
        const vy = finiteNumberOrNull(message.vy ?? message.velocity?.y) ?? 0;

        try {
          if (typeof rufflePlayer?.fireWaterSetPlayerState === "function") {
            const applied = Boolean(rufflePlayer.fireWaterSetPlayerState(character, x, y, vx, vy));
            if (applied && !swfWriteBridgeReady) {
              swfWriteBridgeReady = true;
              updateRoomBadge();
            }
            return applied;
          }

          const ruffleApi = rufflePlayer?.ruffle?.();
          if (typeof ruffleApi?.callExternalInterface === "function") {
            const applied = Boolean(ruffleApi.callExternalInterface("fireWaterSetPlayerState", character, x, y, vx, vy));
            if (applied && !swfWriteBridgeReady) {
              swfWriteBridgeReady = true;
              updateRoomBadge();
            }
            return applied;
          }
        } catch (error) {
          if (!remotePositionBridgeErrorLogged) {
            remotePositionBridgeErrorLogged = true;
            debugLog("remote position bridge unavailable", error);
          }
        }

        return false;
      }

      function dispatchKeyboard(action, code, keyInfo) {
        for (const dispatchTarget of ruffleEventTargets()) {
          const keyboardEvent = createKeyboardEvent(action, code, keyInfo, 0);
          dispatchTarget.dispatchEvent(keyboardEvent);

          if (action === "keydown" && keyInfo.key.length === 1) {
            dispatchTarget.dispatchEvent(createKeyboardEvent("keypress", code, keyInfo, keyInfo.key.charCodeAt(0)));
          }
        }
      }

      function createKeyboardEvent(action, code, keyInfo, charCode) {
        const keyboardEvent = new KeyboardEvent(action, {
            key: keyInfo.key,
            code,
            keyCode: keyInfo.keyCode,
            which: keyInfo.keyCode,
            charCode,
            location: 0,
            repeat: false,
            view: window,
            bubbles: true,
            composed: true,
            cancelable: true
          });
        defineKeyCode(keyboardEvent, keyInfo.keyCode, charCode);
        return keyboardEvent;
      }

      function defineKeyCode(event, keyCode, charCode = 0) {
        for (const property of ["keyCode", "which", "charCode"]) {
          try {
            Object.defineProperty(event, property, {
              get: () => (property === "charCode" ? charCode : keyCode)
            });
          } catch {
            debugLog("key code define failed", property);
          }
        }
      }

      function sendInput(action, role, code) {
        if (!ROLE_KEYMAP[role]?.[code]) return;
        const keyInfo = ROLE_KEYMAP[role][code];
        const inputSeq = ++seq;
        sendRaw(buildMovementPayload("input", role, {
          action,
          code,
          key: keyInfo.key,
          seq: inputSeq
        }));
        sendLocalState("input", inputSeq);
      }

      function sendLocalState(reason = "state", inputSeq = seq) {
        if (!(assignedRole === "fire" || assignedRole === "water")) return;
        if (socket?.readyState !== WebSocket.OPEN) return;

        const heldCodes = currentHeldCodesForRole(assignedRole);
        if (reason === "heartbeat" && heldCodes.length === 0) return;

        sendRaw(buildMovementPayload("state", assignedRole, {
          reason,
          seq: ++stateSeq,
          inputSeq
        }));
      }

      function releaseLocalHeldKeys() {
        const releasedCodes = Array.from(localHeldCodes);
        localHeldCodes.clear();

        for (const code of releasedCodes) {
          if (!canSendCode(code)) continue;
          const keyInfo = ROLE_KEYMAP[assignedRole][code];
          dispatchKeyboard("keyup", code, keyInfo);
          sendInput("keyup", assignedRole, code);
        }
      }

      function releaseRemoteHeldKeys() {
        for (const remoteHeldKey of remoteHeldCodes) {
          const [role, code] = remoteHeldKey.split(":");
          const keyInfo = ROLE_KEYMAP[role]?.[code];
          if (keyInfo) {
            dispatchKeyboard("keyup", code, keyInfo);
          }
        }
        remoteHeldCodes.clear();
        lastRemoteSeqByRole.clear();
        lastRemoteStateSeqByRole.clear();
      }

      function releaseTouchHeldKeys() {
        const releasedTouches = Array.from(touchHeld.values());
        touchHeld.clear();

        for (const held of releasedTouches) {
          held.button.classList.remove("is-active");
          const keyInfo = ROLE_KEYMAP[held.role]?.[held.code];
          if (keyInfo) {
            dispatchKeyboard("keyup", held.code, keyInfo);
            if (assignedRole === held.role) {
              sendInput("keyup", held.role, held.code);
            }
          }
        }
      }

      function isTouchCodeHeld(role, code) {
        for (const held of touchHeld.values()) {
          if (held.role === role && held.code === code) {
            return true;
          }
        }

        return false;
      }

      function preventTouchControlDefault(event) {
        event.preventDefault();
      }

      function handleTouchInput(event) {
        if (!shouldUseTouchControls) return;

        const button = event.currentTarget;
        const control = button.dataset.control;
        const role = localControlRole();
        const code = TOUCH_CONTROL_CODES[role]?.[control];
        const keyInfo = ROLE_KEYMAP[role]?.[code];
        if (!keyInfo) return;

        if (assignedRole === "spectator" || (assignedRole !== "single-player" && assignedRole !== role)) {
          event.preventDefault();
          return;
        }

        event.preventDefault();
        focusRufflePlayer();

        if (event.type === "pointerdown") {
          if (typeof event.pointerId === "number") {
            button.setPointerCapture?.(event.pointerId);
          }
          if (touchHeld.has(event.pointerId)) return;
          const wasHeld = isTouchCodeHeld(role, code);
          touchHeld.set(event.pointerId, { button, role, code });
          button.classList.add("is-active");
          if (!wasHeld) {
            dispatchKeyboard("keydown", code, keyInfo);
            if (assignedRole === role) {
              sendInput("keydown", role, code);
            }
          }
          return;
        }

        const held = touchHeld.get(event.pointerId);
        if (!held) return;
        touchHeld.delete(event.pointerId);
        if (!Array.from(touchHeld.values()).some((activeHeld) => activeHeld.button === held.button)) {
          held.button.classList.remove("is-active");
        }
        const heldKeyInfo = ROLE_KEYMAP[held.role]?.[held.code];
        if (heldKeyInfo && !isTouchCodeHeld(held.role, held.code)) {
          dispatchKeyboard("keyup", held.code, heldKeyInfo);
          if (assignedRole === held.role) {
            sendInput("keyup", held.role, held.code);
          }
        }
      }

      function handleLegacyTouchInput(event) {
        if (!shouldUseTouchControls) return;

        const touches = Array.from(event.changedTouches || []);
        if (touches.length === 0) return;

        for (const touch of touches) {
          handleTouchInput({
            type: event.type === "touchstart" ? "pointerdown" : "pointerup",
            currentTarget: event.currentTarget,
            pointerId: `touch:${touch.identifier}`,
            preventDefault: () => event.preventDefault()
          });
        }
      }

      async function initDiscordActivity() {
        if (!discordClientId) {
          discordText.textContent = "not configured";
          return;
        }

        try {
          const { DiscordSDK } = await import(DISCORD_SDK_MODULE_URL);
          discordSdk = new DiscordSDK(discordClientId);
          discordText.textContent = "initializing";

          if (!explicitRoomId && discordSdk.instanceId) {
            roomId = sanitizeRoom(discordSdk.instanceId) || roomId;
            roomText.textContent = roomId;
            updateRoomBadge();
            syncRoomUrl();
          }

          await withTimeout(discordSdk.ready(), DISCORD_READY_TIMEOUT_MS);
          discordReady = true;
          discordText.textContent = "ready";
          await authenticateDiscordActivity();
          await updateDiscordActivityStatus();
        } catch (error) {
          discordReady = false;
          discordText.textContent = "unavailable";
          debugLog("discord init failed", error);
        }
      }

      function withTimeout(promise, timeoutMs) {
        return Promise.race([
          promise,
          new Promise((_, reject) => window.setTimeout(() => reject(new Error("Discord SDK ready timed out")), timeoutMs))
        ]);
      }

      async function authenticateDiscordActivity() {
        if (!discordSdk?.commands?.authorize || !discordSdk?.commands?.authenticate) return;

        try {
          const auth = await discordSdk.commands.authorize({
            client_id: discordClientId,
            response_type: "code",
            state: "",
            prompt: "none",
            scope: DISCORD_ACTIVITY_SCOPES
          });
          const tokenResponse = await fetch(DISCORD_AUTH_TOKEN_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({ code: auth.code })
          });

          if (!tokenResponse.ok) {
            throw new Error(`Discord token exchange failed: ${tokenResponse.status}`);
          }

          const token = await tokenResponse.json();
          if (typeof token.access_token !== "string" || !token.access_token) {
            throw new Error("Discord token exchange did not return an access token");
          }

          const authenticated = await discordSdk.commands.authenticate({ access_token: token.access_token });
          if (!authenticated) {
            throw new Error("Discord authenticate command returned no user");
          }
          discordAuthenticated = true;
          discordText.textContent = "authenticated";
        } catch (error) {
          if (!isAbortError(error)) {
            console.warn("Discord authentication failed:", error);
          }
          discordAuthenticated = false;
          discordText.textContent = "ready";
          debugLog("discord auth failed", error);
        }
      }

      async function updateDiscordActivityStatus() {
        if (!discordAuthenticated || !discordSdk?.commands?.setActivity) return;

        try {
          const activePlayers = currentPlayers.filter((player) => player.role === "fire" || player.role === "water");
          const activeCount = Math.min(2, Math.max(1, discordParticipants || activePlayers.length || 1));
          const hasHost = activePlayers.some((player) => player.role === "fire");
          const hasJoiner = activePlayers.some((player) => player.role === "water");
          const partyState = hasHost && hasJoiner ? "Host Fireboy + Joiner Watergirl" : "Waiting for Joiner Watergirl";
          await discordSdk.commands.setActivity({
            activity: {
              name: "Fireboy & Watergirl",
              type: 0,
              application_id: discordClientId,
              details: roomGameStarted ? "Playing together" : partyState,
              state: `${activeCount}/2 players - ${partyState}`,
              party: {
                id: roomId,
                size: [activeCount, 2]
              },
              instance: true
            }
          });
        } catch (error) {
          if (!isAbortError(error)) {
            console.warn("Discord activity status update failed:", error);
          }
          debugLog("discord status update failed", { authenticated: discordAuthenticated, error });
        }
      }

      async function refreshDiscordParticipants() {
        if (!discordSdk?.commands?.getInstanceConnectedParticipants) return;
        try {
          const participants = await discordSdk.commands.getInstanceConnectedParticipants();
          updateDiscordParticipants(participants);
        } catch (error) {
          debugLog("discord participants fetch failed", error);
        }
      }

      function subscribeDiscordParticipants(Events) {
        const eventName = Events?.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE || "ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE";
        if (!discordSdk?.subscribe) return;
        try {
          discordSdk.subscribe(eventName, updateDiscordParticipants);
        } catch (error) {
          debugLog("discord participants subscribe failed", error);
        }
      }

      function updateDiscordParticipants(payload) {
        const participants = Array.isArray(payload?.participants)
          ? payload.participants
          : Array.isArray(payload)
            ? payload
            : [];
        discordParticipants = participants.length;
        runBackgroundTask(updateDiscordActivityStatus(), "discord status update");
        if (debugMode) {
          setPlayers(currentPlayers);
        }
      }

      async function copyInviteUrl() {
        const text = inviteUrl();
        try {
          await navigator.clipboard.writeText(text);
        } catch (error) {
          window.prompt("Invite URL", text);
        }
      }

      fullscreenButton?.addEventListener("click", () => {
        enterFullscreen().catch((error) => {
          console.error("Fullscreen failed:", error);
        });
      });

      copyInviteButton?.addEventListener("click", async () => {
        await copyInviteUrl();
        copyInviteButton.textContent = "Copied";
        window.setTimeout(() => {
          copyInviteButton.textContent = "Copy invite URL";
        }, 1400);
      });

      reconnectButton?.addEventListener("click", () => {
        connect();
      });

      for (const button of padButtons) {
        button.addEventListener("pointerdown", handleTouchInput);
        button.addEventListener("pointerup", handleTouchInput);
        button.addEventListener("pointercancel", handleTouchInput);
        button.addEventListener("pointerleave", handleTouchInput);
        button.addEventListener("lostpointercapture", handleTouchInput);
        button.addEventListener("contextmenu", preventTouchControlDefault);
        button.addEventListener("dragstart", preventTouchControlDefault);
        button.addEventListener("selectstart", preventTouchControlDefault);
        if (!window.PointerEvent) {
          button.addEventListener("touchstart", handleLegacyTouchInput, { passive: false });
          button.addEventListener("touchend", handleLegacyTouchInput, { passive: false });
          button.addEventListener("touchcancel", handleLegacyTouchInput, { passive: false });
        }
      }

      target?.addEventListener("pointerup", notifyHostGameStart, true);
      target?.addEventListener("pointerdown", () => {
        installKeyboardListeners();
        requestKeyboardCapture();
      }, true);
      document.addEventListener("focusin", installKeyboardListeners, true);

      installKeyboardListeners();

      window.addEventListener("blur", () => {
        releaseLocalHeldKeys();
        releaseRemoteHeldKeys();
        releaseTouchHeldKeys();
      });

      window.addEventListener("pagehide", () => {
        releaseLocalHeldKeys();
        releaseRemoteHeldKeys();
        releaseTouchHeldKeys();
      });

      document.addEventListener("fullscreenchange", () => {
        const isFullscreen = Boolean(document.fullscreenElement);
        if (fullscreenButton) {
          fullscreenButton.textContent = isFullscreen ? "Exit" : "Fullscreen";
        }
      });

      boot().catch((error) => {
        console.error("Failed to load the SWF file:", error);
      });
      updateTouchControls();
      initDiscordActivity().finally(() => connect());
