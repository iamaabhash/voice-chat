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
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function emitPresence(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const members = Array.from(room.entries()).map(([id, data]) => ({
    id,
    name: data.name,
    avatar: data.avatar || "",
  }));
  io.to(roomId).emit("presence-update", { members });
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name, avatar }) => {
    if (!roomId) return;

    const members = getRoom(roomId);
    if (members.size >= MAX_PEERS) {
      socket.emit("room-full");
      return;
    }

    const existingMembers = Array.from(members.entries()).map(([id, data]) => ({
      id,
      name: data.name,
      avatar: data.avatar || "",
    }));

    socket.data.roomId = roomId;
    socket.data.name = name || "Guest";
    socket.data.avatar = avatar || "";
    members.set(socket.id, { name: socket.data.name, avatar: socket.data.avatar });
    socket.join(roomId);

    socket.emit("room-joined", { roomId, members: existingMembers });
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

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const members = rooms.get(roomId);
    if (members) {
      members.delete(socket.id);
      if (members.size === 0) {
        rooms.delete(roomId);
      } else {
        socket.to(roomId).emit("peer-left", { id: socket.id });
        emitPresence(roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Voice chat server running on http://localhost:${PORT}`);
});
