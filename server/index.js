import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { AccessToken } from "livekit-server-sdk";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const rooms = new Map();
const MAX_PEERS = Number(process.env.MAX_PEERS || 11);
const REJOIN_GRACE_MS = Number(process.env.REJOIN_GRACE_MS || 45000);

const LIVEKIT_URL = process.env.LIVEKIT_URL || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";
const livekitEnabled = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

function parseIceServers() {
  const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const turnUrls = (process.env.TURN_URLS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const iceServers = [];

  if (stunUrls.length) {
    iceServers.push({ urls: stunUrls });
  }

  if (turnUrls.length) {
    iceServers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || "",
    });
  }

  return iceServers;
}

app.get("/config.json", (_req, res) => {
  res.json({
    iceServers: parseIceServers(),
    livekit: {
      enabled: livekitEnabled,
      url: LIVEKIT_URL,
    },
  });
});

app.get("/livekit/token", (req, res) => {
  if (!livekitEnabled) {
    res.status(400).json({ error: "LiveKit is not configured." });
    return;
  }

  const roomId = String(req.query.roomId || "").trim();
  const name = String(req.query.name || "Guest").trim();
  if (!roomId) {
    res.status(400).json({ error: "Missing roomId." });
    return;
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: `${name}-${Date.now()}`,
    name,
  });
  at.addGrant({ room: roomId, roomJoin: true, canPublish: true, canSubscribe: true });
  const token = at.toJwt();
  res.json({ token });
});

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      members: new Map(),
      hostClientId: null,
      locked: false,
      cleanupTimers: new Map(),
    });
  }
  return rooms.get(roomId);
}

function emitPresence(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const members = Array.from(room.members.values()).map((data) => ({
    id: data.socketId,
    name: data.name,
    avatar: data.avatar || "",
    clientId: data.clientId,
    connected: data.connected,
  }));
  io.to(roomId).emit("presence-update", { members, locked: room.locked, hostClientId: room.hostClientId });
}

function assignHostIfNeeded(room) {
  if (room.hostClientId && room.members.has(room.hostClientId)) return;
  const first = room.members.values().next().value;
  room.hostClientId = first ? first.clientId : null;
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name, avatar, clientId }) => {
    if (!roomId) return;
    const safeClientId = String(clientId || "").trim();
    if (!safeClientId) return;

    const room = getRoom(roomId);
    const members = room.members;

    if (room.locked && !members.has(safeClientId)) {
      socket.emit("room-locked");
      return;
    }

    if (!members.has(safeClientId) && members.size >= MAX_PEERS) {
      socket.emit("room-full");
      return;
    }

    const existingMembers = Array.from(members.values())
      .filter((data) => data.connected)
      .map((data) => ({
        id: data.socketId,
        name: data.name,
        avatar: data.avatar || "",
        clientId: data.clientId,
      }));

    socket.data.roomId = roomId;
    socket.data.name = name || "Guest";
    socket.data.avatar = avatar || "";
    socket.data.clientId = safeClientId;
    const existing = members.get(safeClientId);

    if (existing) {
      existing.socketId = socket.id;
      existing.name = socket.data.name;
      existing.avatar = socket.data.avatar;
      existing.connected = true;
      existing.lastSeen = Date.now();
      const timer = room.cleanupTimers.get(safeClientId);
      if (timer) {
        clearTimeout(timer);
        room.cleanupTimers.delete(safeClientId);
      }
    } else {
      members.set(safeClientId, {
        clientId: safeClientId,
        socketId: socket.id,
        name: socket.data.name,
        avatar: socket.data.avatar,
        connected: true,
        lastSeen: Date.now(),
      });
    }
    socket.join(roomId);

    if (!room.hostClientId) {
      room.hostClientId = safeClientId;
    }

    socket.emit("room-joined", {
      roomId,
      members: existingMembers,
      isHost: room.hostClientId === safeClientId,
      locked: room.locked,
    });
    emitPresence(roomId);
  });

  socket.on("offer", ({ roomId, to, sdp }) => {
    if (!to) return;
    io.to(to).emit("offer", { from: socket.id, sdp });
  });

  socket.on("answer", ({ roomId, to, sdp }) => {
    if (!to) return;
    io.to(to).emit("answer", { from: socket.id, sdp });
  });

  socket.on("ice-candidate", ({ roomId, to, candidate }) => {
    if (!to) return;
    io.to(to).emit("ice-candidate", { from: socket.id, candidate });
  });

  socket.on("chat-message", ({ roomId, text }) => {
    if (!roomId || !text) return;
    const cleanText = String(text).trim();
    if (!cleanText) return;
    const payload = {
      id: `${socket.id}-${Date.now()}`,
      name: socket.data.name || "Guest",
      avatar: socket.data.avatar || "",
      text: cleanText.slice(0, 500),
      ts: Date.now(),
    };
    io.to(roomId).emit("chat-message", payload);
  });

  socket.on("heartbeat", ({ roomId, clientId }) => {
    if (!roomId || !clientId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const member = room.members.get(clientId);
    if (!member) return;
    member.lastSeen = Date.now();
  });

  socket.on("toggle-lock", ({ roomId, clientId, locked }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostClientId !== clientId) return;
    room.locked = Boolean(locked);
    emitPresence(roomId);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;
    const clientId = socket.data.clientId;
    if (!clientId) return;

    const member = room.members.get(clientId);
    if (member) {
      member.connected = false;
      member.lastSeen = Date.now();
    }

    socket.to(roomId).emit("peer-left", { id: socket.id });
    emitPresence(roomId);

    if (room.cleanupTimers.has(clientId)) {
      clearTimeout(room.cleanupTimers.get(clientId));
    }
    const timer = setTimeout(() => {
      const currentRoom = rooms.get(roomId);
      if (!currentRoom) return;
      const currentMember = currentRoom.members.get(clientId);
      if (!currentMember) return;
      if (currentMember.connected) return;
      currentRoom.members.delete(clientId);
      currentRoom.cleanupTimers.delete(clientId);
      assignHostIfNeeded(currentRoom);
      emitPresence(roomId);
      if (currentRoom.members.size === 0) {
        rooms.delete(roomId);
      }
    }, REJOIN_GRACE_MS);
    room.cleanupTimers.set(clientId, timer);
  });
});

server.listen(PORT, () => {
  console.log(`Voice chat server running on http://localhost:${PORT}`);
});
