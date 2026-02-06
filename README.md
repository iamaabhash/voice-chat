# Voice Chat

A lightweight voice-chat app with WebRTC + Socket.IO. By default it uses a peer-to-peer mesh, and it can switch to LiveKit (SFU) when configured.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in multiple tabs or devices and join the same room.

## Environment Variables

Create a `.env` file (or set environment variables in your host) to enable TURN or LiveKit.

```bash
# Limit room size (mesh mode)
MAX_PEERS=11

# TURN / STUN
STUN_URLS=stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_USERNAME=example
TURN_CREDENTIAL=example

# LiveKit (SFU)
LIVEKIT_URL=wss://your-livekit.example.com
LIVEKIT_API_KEY=your_key
LIVEKIT_API_SECRET=your_secret
```

## Mesh vs. SFU

- **Mesh (default):** Simple, fast to set up, but should stay small (around 6 users). Controlled with `MAX_PEERS`.
- **SFU (LiveKit):** Scales better and is more reliable. Configure LiveKit env vars and the client will automatically connect to it.

## Deployment Notes

- **HTTPS is required** for microphone access in production (localhost is the only exception).
- **TURN is recommended** for NAT traversal and reliability.
- For larger rooms, **use LiveKit** instead of mesh.

### Quick Deploy Path (Example)

1. Deploy this server to Render/Fly/Heroku.
2. Set the environment variables in the provider dashboard.
3. Provide a valid HTTPS domain.
4. If using LiveKit, deploy a LiveKit server and set `LIVEKIT_*` vars.

If you'd like, I can add a provider-specific deployment config and CI pipeline next.
