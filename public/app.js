const socket = io();

const joinCard = document.getElementById("join-card");
const callCard = document.getElementById("call-card");
const joinButton = document.getElementById("join");
const startRoomButton = document.getElementById("start-room");
const createRoomButton = document.getElementById("create-room");
const copyLinkButton = document.getElementById("copy-link");
const leaveButton = document.getElementById("leave");
const toggleMicButton = document.getElementById("toggle-mic");
const toggleMiniButton = document.getElementById("toggle-mini");
const micState = document.getElementById("mic-state");
const connectionState = document.getElementById("connection-state");
const miniCall = document.getElementById("mini-call");
const miniRoom = document.getElementById("mini-room");
const miniStatus = document.getElementById("mini-status");
const miniMic = document.getElementById("mini-mic");
const miniLeave = document.getElementById("mini-leave");
const closeMini = document.getElementById("close-mini");
const miniHeader = document.querySelector(".mini-header");
const roomTitle = document.getElementById("room-title");
const callStatus = document.getElementById("call-status");
const remoteAudios = document.getElementById("remote-audios");
const peopleList = document.getElementById("people-list");
const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let localStream = null;
const peerConnections = new Map();
let roomId = "";
let micEnabled = false;
let displayName = "Guest";
let displayAvatar = "";

const STORAGE_KEYS = {
  name: "voicechat.name",
  avatar: "voicechat.avatar",
};

const defaultIceServers = [
  { urls: ["stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"] },
];

let rtcConfig = { iceServers: defaultIceServers };
let appConfig = { iceServers: defaultIceServers, livekit: { enabled: false, url: "" } };
let useLivekit = false;
let livekitRoom = null;
let livekitAudioTrack = null;
const configReady = loadConfig();

function setStatus(message) {
  callStatus.textContent = message;
  miniStatus.textContent = message;
}

function setConnectionState(label, variant) {
  connectionState.textContent = label;
  connectionState.classList.remove("connected", "relay");
  if (variant) {
    connectionState.classList.add(variant);
  }
}

function setMicState(enabled) {
  micEnabled = enabled;
  micState.textContent = `Mic: ${enabled ? "On" : "Off"}`;
  toggleMicButton.textContent = enabled ? "Mute mic" : "Enable mic";
  miniMic.textContent = enabled ? "Mute" : "Mic";
}

async function ensureLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  setMicState(true);
  return localStream;
}

async function loadConfig() {
  try {
    const response = await fetch("/config.json");
    if (!response.ok) return;
    const data = await response.json();
    appConfig = data;
    rtcConfig = { iceServers: data.iceServers?.length ? data.iceServers : defaultIceServers };
    useLivekit = Boolean(data.livekit?.enabled && data.livekit?.url);
  } catch (err) {
    console.warn("Failed to load config, using defaults.", err);
  }
}

function attachRemoteStream(peerId, stream) {
  let audio = document.querySelector(`[data-peer-audio="${peerId}"]`);
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.dataset.peerAudio = peerId;
    remoteAudios.appendChild(audio);
  }
  audio.srcObject = stream;
}

function removeRemoteStream(peerId) {
  const audio = document.querySelector(`[data-peer-audio="${peerId}"]`);
  if (audio) {
    audio.remove();
  }
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections.set(peerId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", { roomId, to: peerId, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    attachRemoteStream(peerId, event.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      setStatus("Connected! Say hi.");
      setConnectionState("Connected", "connected");
    }
  };

  return pc;
}

function closePeer(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.close();
    peerConnections.delete(peerId);
  }
  removeRemoteStream(peerId);
}

function renderPeople(members) {
  peopleList.innerHTML = "";
  members.forEach((member) => {
    const li = document.createElement("li");
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = member.avatar || member.name.slice(0, 1).toUpperCase();
    const name = document.createElement("span");
    name.textContent = member.name;
    li.append(avatar, name);
    peopleList.appendChild(li);
  });
}

function appendMessage({ name, text, ts }) {
  const wrapper = document.createElement("div");
  wrapper.className = "chat-message";
  const meta = document.createElement("div");
  meta.className = "chat-meta";
  const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.textContent = `${name} · ${time}`;
  const body = document.createElement("div");
  body.textContent = text;
  wrapper.append(meta, body);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function connectToPeers(members) {
  if (!members.length) return;
  const stream = await ensureLocalStream();
  for (const member of members) {
    if (peerConnections.has(member.id)) continue;
    const pc = createPeerConnection(member.id);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", { roomId, to: member.id, sdp: offer });
  }
}

async function updateRelayStatus() {
  if (useLivekit) {
    setConnectionState("SFU (LiveKit)", "connected");
    return;
  }
  const relayed = [];
  for (const pc of peerConnections.values()) {
    const stats = await pc.getStats();
    stats.forEach((report) => {
      if (report.type === "candidate-pair" && report.state === "succeeded" && report.selected) {
        const local = stats.get(report.localCandidateId);
        if (local && local.candidateType === "relay") {
          relayed.push(true);
        }
      }
    });
  }
  if (relayed.length) {
    setConnectionState("Using TURN relay", "relay");
  }
}

function generateRoomId() {
  const adjectives = ["ocean", "sunny", "brisk", "amber", "quiet", "lucky", "cosmic"];
  const nouns = ["forest", "comet", "harbor", "meadow", "signal", "studio", "ridge"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 900 + 100);
  return `${adj}-${noun}-${num}`;
}

function getRoomInput() {
  return document.getElementById("room");
}

function getNameInput() {
  return document.getElementById("name");
}

function getAvatarInput() {
  return document.getElementById("avatar");
}

function syncRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get("room");
  if (roomParam) {
    getRoomInput().value = roomParam;
  }
}

function syncProfileFromStorage() {
  const savedName = localStorage.getItem(STORAGE_KEYS.name);
  const savedAvatar = localStorage.getItem(STORAGE_KEYS.avatar);
  if (savedName) {
    getNameInput().value = savedName;
  }
  if (savedAvatar) {
    getAvatarInput().value = savedAvatar;
  }
}

async function startLivekit(roomIdToJoin) {
  if (!useLivekit) return;
  if (livekitRoom) return;

  const { connect, createLocalAudioTrack } = await import("https://cdn.skypack.dev/livekit-client");
  const tokenResponse = await fetch(
    `/livekit/token?roomId=${encodeURIComponent(roomIdToJoin)}&name=${encodeURIComponent(displayName)}`
  );
  if (!tokenResponse.ok) {
    setStatus("Failed to get LiveKit token.");
    return;
  }
  const { token } = await tokenResponse.json();
  livekitRoom = await connect(appConfig.livekit.url, token, { autoSubscribe: true });
  livekitAudioTrack = await createLocalAudioTrack();
  await livekitRoom.localParticipant.publishTrack(livekitAudioTrack);
  setMicState(true);
  setStatus("Connected via LiveKit.");
}

joinButton.addEventListener("click", async () => {
  await configReady;
  const nameInput = getNameInput();
  const avatarInput = getAvatarInput();
  const roomInput = getRoomInput();
  roomId = roomInput.value.trim();
  displayName = nameInput.value.trim() || "Guest";
  displayAvatar = avatarInput.value.trim();

  if (!roomId) {
    alert("Please enter a room ID.");
    return;
  }

  localStorage.setItem(STORAGE_KEYS.name, displayName);
  localStorage.setItem(STORAGE_KEYS.avatar, displayAvatar);
  socket.emit("join-room", { roomId, name: displayName, avatar: displayAvatar });
});

startRoomButton.addEventListener("click", () => {
  if (!getRoomInput().value.trim()) {
    getRoomInput().value = generateRoomId();
  }
  joinButton.click();
});

toggleMiniButton.addEventListener("click", () => {
  miniCall.hidden = !miniCall.hidden;
});

createRoomButton.addEventListener("click", () => {
  const newRoom = generateRoomId();
  getRoomInput().value = newRoom;
});

copyLinkButton.addEventListener("click", async () => {
  const currentRoom = getRoomInput().value.trim() || generateRoomId();
  getRoomInput().value = currentRoom;
  const inviteUrl = `${window.location.origin}?room=${encodeURIComponent(currentRoom)}`;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    copyLinkButton.textContent = "Link copied!";
    setTimeout(() => {
      copyLinkButton.textContent = "Copy invite link";
    }, 1500);
  } catch (err) {
    prompt("Copy this link:", inviteUrl);
  }
});

leaveButton.addEventListener("click", () => {
  if (livekitRoom) {
    livekitRoom.disconnect();
  }
  window.location.reload();
});

miniLeave.addEventListener("click", () => {
  leaveButton.click();
});

toggleMicButton.addEventListener("click", async () => {
  if (livekitAudioTrack) {
    livekitAudioTrack.enabled = !livekitAudioTrack.enabled;
    setMicState(livekitAudioTrack.enabled);
    return;
  }
  if (!localStream) {
    await ensureLocalStream();
  }
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !track.enabled;
    setMicState(track.enabled);
  });
});

miniMic.addEventListener("click", async () => {
  toggleMicButton.click();
});

closeMini.addEventListener("click", () => {
  miniCall.hidden = true;
});

let dragActive = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

function startDrag(event) {
  dragActive = true;
  const rect = miniCall.getBoundingClientRect();
  const point = event.touches ? event.touches[0] : event;
  dragOffsetX = point.clientX - rect.left;
  dragOffsetY = point.clientY - rect.top;
}

function onDrag(event) {
  if (!dragActive) return;
  const point = event.touches ? event.touches[0] : event;
  const x = Math.min(window.innerWidth - rectWidth(), Math.max(0, point.clientX - dragOffsetX));
  const y = Math.min(window.innerHeight - rectHeight(), Math.max(0, point.clientY - dragOffsetY));
  miniCall.style.left = `${x}px`;
  miniCall.style.top = `${y}px`;
  miniCall.style.right = "auto";
  miniCall.style.bottom = "auto";
}

function stopDrag() {
  dragActive = false;
}

function rectWidth() {
  return miniCall.getBoundingClientRect().width;
}

function rectHeight() {
  return miniCall.getBoundingClientRect().height;
}

miniHeader.addEventListener("mousedown", startDrag);
window.addEventListener("mousemove", onDrag);
window.addEventListener("mouseup", stopDrag);
miniHeader.addEventListener("touchstart", startDrag, { passive: true });
window.addEventListener("touchmove", onDrag, { passive: true });
window.addEventListener("touchend", stopDrag);

socket.on("room-full", () => {
  alert("That room is full. Try another room ID.");
});

socket.on("room-joined", async ({ roomId: joinedRoomId, members }) => {
  joinCard.hidden = true;
  callCard.hidden = false;
  roomTitle.textContent = `Room: ${joinedRoomId}`;
  miniRoom.textContent = joinedRoomId;
  miniCall.hidden = false;
  setConnectionState("Connecting");
  if (useLivekit) {
    setStatus("Connecting via LiveKit...");
    await startLivekit(joinedRoomId);
    await updateRelayStatus();
  } else {
    setStatus(members.length ? "Connecting to peers..." : "Waiting for someone to join...");
    await connectToPeers(members);
    setTimeout(updateRelayStatus, 1500);
  }
});

socket.on("offer", async ({ from, sdp }) => {
  if (useLivekit) return;
  let pc = peerConnections.get(from);
  if (!pc) {
    pc = createPeerConnection(from);
    const stream = await ensureLocalStream();
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  }
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("answer", { roomId, to: from, sdp: answer });
});

socket.on("answer", async ({ from, sdp }) => {
  if (useLivekit) return;
  const pc = peerConnections.get(from);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
});

socket.on("ice-candidate", async ({ from, candidate }) => {
  if (useLivekit) return;
  if (!candidate) return;
  const pc = peerConnections.get(from);
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error("Failed to add ICE candidate", err);
  }
});

socket.on("peer-left", ({ id }) => {
  setStatus("Peer left. Waiting for someone else...");
  if (!useLivekit) {
    closePeer(id);
  }
});

socket.on("presence-update", ({ members }) => {
  renderPeople(members);
});

socket.on("chat-message", (payload) => {
  appendMessage(payload);
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit("chat-message", { roomId, text });
  chatInput.value = "";
});

syncRoomFromUrl();
syncProfileFromStorage();
if (!getRoomInput().value.trim()) {
  getRoomInput().value = generateRoomId();
}
