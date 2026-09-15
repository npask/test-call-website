// ─────────────────────────────────────────────────────────────────────────────
// VoiceChat – app.js  (complete, WebRTC + live audio)
// ─────────────────────────────────────────────────────────────────────────────

const socket = io();

// ─────────────────────────────
// STATE
// ─────────────────────────────
let localStream = null;
let muted        = false;
let joined       = false;
let activeChannel = new URLSearchParams(location.search).get("channel") || "general";
let activeInvite = new URLSearchParams(location.search).get("invite") || "";
let channels = [];

// peer connections: socketId → { pc: RTCPeerConnection, gainNode: GainNode }
const peers = {};

// AudioContext for speaking detection & input gain
let audioCtx         = null;
let analyser         = null;
let inputGainNode    = null;
let speakingInterval = null;
let isSpeaking       = false;

// Preferences from localStorage
let username   = localStorage.getItem("vc_username")   || "";
let avatar     = localStorage.getItem("vc_avatar")     || "";
let accentColor= localStorage.getItem("vc_accent")     || "#5865f2";
let profileColor=localStorage.getItem("vc_profileColor")|| "#5865f2";
let inputVolume= parseFloat(localStorage.getItem("vc_inputVol") || "1");
let threshold  = parseInt(localStorage.getItem("vc_threshold")   || "15");
let bgTheme    = localStorage.getItem("vc_bg")         || "dark";
let compact    = localStorage.getItem("vc_compact")    === "true";
let noiseSp    = localStorage.getItem("noiseSp")    === "false";

// ─────────────────────────────
// DOM REFS
// ─────────────────────────────
const privacyOverlay   = document.getElementById("privacyOverlay");
const setupOverlay     = document.getElementById("setupOverlay");
const settingsOverlay  = document.getElementById("settingsOverlay");

const participantsEl   = document.getElementById("participants");
const emptyState       = document.getElementById("emptyState");
const channelCount     = document.getElementById("channelCount");
const latencyBadge     = document.getElementById("latencyBadge");
const channelList      = document.getElementById("channelList");
const channelTitle     = document.getElementById("channelTitle");
const inviteBtn        = document.getElementById("inviteBtn");

const joinBtn          = document.getElementById("joinBtn");
const leaveBtn         = document.getElementById("leaveBtn");
const ctrlMute         = document.getElementById("ctrlMute");
const muteBtn          = document.getElementById("muteBtn");

const micIcon          = document.getElementById("micIcon");
const mutedIcon        = document.getElementById("mutedIcon");
const ctrlMicIcon      = document.getElementById("ctrlMicIcon");
const ctrlMutedIcon    = document.getElementById("ctrlMutedIcon");

const selfName         = document.getElementById("selfName");
const selfStatus       = document.getElementById("selfStatus");
const selfInitial      = document.getElementById("selfInitial");
const selfAvatarImg    = document.getElementById("selfAvatarImg");
const selfSpeakingRing = document.getElementById("selfSpeakingRing");
const connectionStatus = document.getElementById("connectionStatus");

// ─────────────────────────────
// WEBRTC CONFIG
// ─────────────────────────────
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

// ─────────────────────────────
// AUDIO UTILS
// ─────────────────────────────
function getOrCreateAudioContext() {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function setupInputAudioPipeline(stream) {
  const ctx = getOrCreateAudioContext();
  const source = ctx.createMediaStreamSource(stream);

  inputGainNode = ctx.createGain();
  inputGainNode.gain.value = inputVolume;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.3;

  // Route: source → gain → analyser (NOT to destination — avoids mic feedback)
  source.connect(inputGainNode);
  inputGainNode.connect(analyser);

  // Create a new stream from the gain node for sending to peers
  const dest = ctx.createMediaStreamDestination();
  inputGainNode.connect(dest);

  // Replace the audio track in localStream with the processed one
  const processedTrack = dest.stream.getAudioTracks()[0];
  const originalTrack  = stream.getAudioTracks()[0];
  originalTrack.enabled = !muted;

  // We'll use processedTrack in peer connections instead of original
  return { processedStream: dest.stream, gainNode: inputGainNode };
}

function startSpeakingDetection() {
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);

  speakingInterval = setInterval(() => {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const level = avg / 2.56; // 0-100

    // Update mic meter in settings
    const bar = document.getElementById("micMeterBar");
    if (bar) bar.style.width = `${Math.min(level, 100)}%`;

    const speaking = level > threshold && !muted;

    if (speaking !== isSpeaking) {
      isSpeaking = speaking;
      socket.emit("speaking", speaking);
      selfSpeakingRing.classList.toggle("active", speaking);
    }
  }, 80);
}

function stopSpeakingDetection() {
  if (speakingInterval) {
    clearInterval(speakingInterval);
    speakingInterval = null;
  }
  isSpeaking = false;
  selfSpeakingRing.classList.remove("active");
}

// Play remote audio from a peer
function attachRemoteAudio(socketId, remoteStream) {
  const ctx = getOrCreateAudioContext();
  const source = ctx.createMediaStreamSource(remoteStream);

  const gainNode = ctx.createGain();
  gainNode.gain.value = 1.0;

  source.connect(gainNode);
  gainNode.connect(ctx.destination);

  if (peers[socketId]) peers[socketId].gainNode = gainNode;

  // Also create a hidden <audio> as fallback for Safari / Autoplay
  let el = document.getElementById(`audio-${socketId}`);
  if (!el) {
    el = document.createElement("audio");
    el.id = `audio-${socketId}`;
    el.autoplay = true;
    el.style.display = "none";
    document.body.appendChild(el);
  }
  el.srcObject = remoteStream;
}

// ─────────────────────────────
// PEER CONNECTION HELPERS
// ─────────────────────────────
function createPeerConnection(remoteId, processedStream) {
  if (peers[remoteId]) destroyPeer(remoteId);

  const pc = new RTCPeerConnection(RTC_CONFIG);

  peers[remoteId] = { pc, gainNode: null };

  // Add local tracks
  processedStream.getTracks().forEach(track => {
    pc.addTrack(track, processedStream);
  });

  // Remote audio
  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) {
      attachRemoteAudio(remoteId, e.streams[0]);
    }
  };

  // ICE candidates → relay via server
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("signal", {
        to: remoteId,
        signal: { type: "candidate", candidate: e.candidate }
      });
    }
  };

  pc.onconnectionstatechange = () => {
    updateLatencyBadge();
  };

  return pc;
}

function destroyPeer(id) {
  if (!peers[id]) return;
  try { peers[id].pc.close(); } catch(_) {}

  // Disconnect gain node
  if (peers[id].gainNode) {
    try { peers[id].gainNode.disconnect(); } catch(_) {}
  }

  delete peers[id];

  // Remove audio element
  const el = document.getElementById(`audio-${id}`);
  if (el) el.remove();
}

// Initiate call to a specific peer
async function callPeer(remoteId, processedStream) {
  const pc = createPeerConnection(remoteId, processedStream);

  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    socket.emit("signal", {
      to: remoteId,
      signal: { type: "offer", sdp: pc.localDescription }
    });
  } catch (err) {
    console.error("callPeer error", err);
  }
}

// ─────────────────────────────
// SOCKET EVENTS
// ─────────────────────────────
socket.on("connect", () => {
  updateConnectionStatus(true);
  pingLoop();
});

socket.on("disconnect", () => {
  updateConnectionStatus(false);
  Object.keys(peers).forEach(destroyPeer);
});

socket.on("channels", list => { channels = list; renderChannels(); });
socket.on("channel-created", channel => {
  activeChannel = channel.id; activeInvite = channel.invite; renderChannels();
  navigator.clipboard?.writeText(`${location.origin}${location.pathname}?channel=${channel.id}&invite=${channel.invite}`);
  toast("Privater Kanal erstellt – Einladungslink kopiert", "success");
});
socket.on("join-error", message => { toast(message, "error"); if (joined) leaveBtn.click(); });
function renderChannels() {
  channelList.innerHTML = "";
  channels.forEach(c => {
    const el = document.createElement("button"); el.className = `channel-item ${c.id === activeChannel ? "active" : ""}`;
    el.innerHTML = `<span class="channel-hash">${c.private ? "🔒" : "🔊"}</span><span class="channel-name"></span><span class="channel-count">${c.count || ""}</span>`;
    el.querySelector(".channel-name").textContent = c.name; el.onclick = () => switchChannel(c.id); channelList.appendChild(el);
  });
  const current = channels.find(c => c.id === activeChannel) || channels[0];
  if (current) { activeChannel = current.id; channelTitle.textContent = current.name; inviteBtn.style.display = current.private ? "inline-flex" : "none"; }
}
function switchChannel(id) { if (id === activeChannel) return; const reconnect = joined; if (reconnect) leaveBtn.click(); activeChannel = id; activeInvite = new URLSearchParams(location.search).get("invite") || ""; renderChannels(); if (reconnect) joinBtn.click(); }
document.getElementById("createChannelBtn").onclick = () => { const name = prompt("Name für deinen privaten Kanal:"); if (name) socket.emit("create-channel", { name }); };
inviteBtn.onclick = () => { const url = `${location.origin}${location.pathname}?channel=${activeChannel}&invite=${activeInvite}`; navigator.clipboard?.writeText(url); toast("Einladungslink kopiert", "success"); };

// Full user list on join/change
socket.on("users", (users) => {
  renderUsers(users);
  const count = Object.keys(users).length;
  channelCount.textContent = count > 0 ? count : "";
});

// Someone new joined → we call them
socket.on("user-joined", async (data) => {
  toast(`${data.username} ist beigetreten`, "info");

  if (joined && localStream) {
    const { processedStream } = setupInputAudioPipeline(localStream);
    await callPeer(data.id, processedStream);
  }
});

// Someone left
socket.on("user-left", (id) => {
  destroyPeer(id);
  toast("Ein Nutzer hat den Kanal verlassen", "info");
});

// WebRTC signaling
socket.on("signal", async ({ from, signal }) => {
  if (!joined) return;

  // Get or create peer
  let pc = peers[from]?.pc;

  if (signal.type === "offer") {
    const { processedStream } = setupInputAudioPipeline(localStream);
    pc = createPeerConnection(from, processedStream).pc || createPeerConnection(from, processedStream);
    pc = peers[from].pc;

    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("signal", {
      to: from,
      signal: { type: "answer", sdp: pc.localDescription }
    });

  } else if (signal.type === "answer") {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

  } else if (signal.type === "candidate") {
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (err) {
      // ignore benign ICE errors
    }
  }
});

// Speaking indicator from others
socket.on("speaking", ({ id, speaking }) => {
  const card = document.getElementById(`participant-${id}`);
  if (!card) return;
  card.classList.toggle("speaking", speaking);
  const statusEl = card.querySelector(".participant-status");
  if (statusEl) {
    statusEl.textContent = speaking ? "spricht..." : "idle";
    statusEl.className = `participant-status ${speaking ? "speaking-label" : ""}`;
  }
});

// Mute state from others
socket.on("mute-state", ({ id, muted: m }) => {
  const card = document.getElementById(`participant-${id}`);
  if (!card) return;
  const badge = card.querySelector(".participant-muted-badge");
  if (m && !badge) {
    const wrap = card.querySelector(".participant-avatar-wrap");
    const div = document.createElement("div");
    div.className = "participant-muted-badge";
    div.textContent = "🔇";
    wrap.appendChild(div);
  } else if (!m && badge) {
    badge.remove();
  }
});

// ─────────────────────────────
// JOIN / LEAVE
// ─────────────────────────────
joinBtn.onclick = async () => {
  if (joined) return;

  // Resume AudioContext on user gesture
  getOrCreateAudioContext();

  try {
    const micId = localStorage.getItem("vc_micId");
    const constraints = {
      audio: {
        echoCancellation: noiseSp,
        noiseSuppression: noiseSp,
        autoGainControl: noiseSp,
        ...(micId ? { deviceId: { exact: micId } } : {})
      }
    };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);

    socket.emit("join", { username, avatar, profileColor, channelId: activeChannel, invite: activeInvite });

    joined = true;

    const { processedStream } = setupInputAudioPipeline(localStream);
    startSpeakingDetection();

    // Store processedStream for new peers
    socket._processedStream = processedStream;

    joinBtn.style.display = "none";
    leaveBtn.style.display = "inline-flex";
    ctrlMute.disabled = false;

    selfStatus.textContent = "Verbunden";
    updateConnectionStatus(true, true);

    toast("Du bist dem Kanal beigetreten", "success");
  } catch (e) {
    console.error(e);
    toast("Mikrofon-Zugriff verweigert", "error");
  }
};

leaveBtn.onclick = () => {
  socket.emit("leave");

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  stopSpeakingDetection();
  Object.keys(peers).forEach(destroyPeer);

  joined = false;

  joinBtn.style.display = "inline-flex";
  leaveBtn.style.display = "none";
  ctrlMute.disabled = true;

  participantsEl.innerHTML = "";
  emptyState.style.display = "flex";
  channelCount.textContent = "";

  selfStatus.textContent = "Offline";
  updateConnectionStatus(true, false);

  latencyBadge.style.display = "none";

  toast("Du hast den Kanal verlassen", "info");
};

// ─────────────────────────────
// MUTE
// ─────────────────────────────
function setMuteUI(state) {
  muted = state;

  if (localStream) {
    localStream.getAudioTracks().forEach(t => {
      t.enabled = !state;
    });
  }

  ctrlMicIcon.style.display    = state ? "none"  : "block";
  ctrlMutedIcon.style.display  = state ? "block" : "none";
  micIcon.style.display        = state ? "none"  : "block";
  mutedIcon.style.display      = state ? "block" : "none";

  ctrlMute.classList.toggle("muted", state);
}

ctrlMute.onclick = () => {
  setMuteUI(!muted);
  socket.emit("mute-state", muted);
};

muteBtn.onclick = () => {
  setMuteUI(!muted);
  socket.emit("mute-state", muted);
};

// Local soundboard: 1–4 play a short confirmation tone without broadcasting it.
document.addEventListener("keydown", e => {
  if (!joined || e.target.matches("input,textarea") || !({1:1,2:1,3:1,4:1})[e.key]) return;
  const ctx = getOrCreateAudioContext(), osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.frequency.value = ({1:523,2:659,3:784,4:988})[e.key]; gain.gain.setValueAtTime(.08, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .18);
  osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + .18);
});
document.getElementById("soundBtn").onclick = () => {
  const ctx = getOrCreateAudioContext(), osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.frequency.value = 740; gain.gain.setValueAtTime(.06, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .14);
  osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + .14);
};

// Keyboard shortcut: M = toggle mute
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key.toLowerCase() === "m" && joined) {
    setMuteUI(!muted);
    socket.emit("mute-state", muted);
  }
});

// ─────────────────────────────
// RENDER PARTICIPANTS
// ─────────────────────────────
function renderUsers(users) {
  const list = Object.entries(users || {});

  participantsEl.innerHTML = "";

  if (list.length === 0) {
    emptyState.style.display = "flex";
    return;
  }

  emptyState.style.display = "none";

  for (const [id, u] of list) {
    const card = document.createElement("div");
    card.className = `participant ${u.speaking ? "speaking" : ""}`;
    card.id = `participant-${id}`;

    card.innerHTML = `
      <div class="participant-avatar-wrap">
        <div class="participant-avatar" style="color:${u.profileColor || "#5865f2"}">
          ${
            u.avatar
              ? `<img src="${u.avatar}" alt="${u.username}">`
              : `<span>${(u.username || "?")[0].toUpperCase()}</span>`
          }
        </div>
        ${u.muted ? `<div class="participant-muted-badge">🔇</div>` : ""}
      </div>
      <div class="participant-name">${escapeHtml(u.username)}</div>
      <div class="participant-status ${u.speaking ? "speaking-label" : ""}">
        ${u.speaking ? "spricht..." : "idle"}
      </div>
    `;

    participantsEl.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

// ─────────────────────────────
// PRIVACY OVERLAY
// ─────────────────────────────
if (localStorage.getItem("vc_privacyAccepted")) {
  privacyOverlay.style.display = "none";
} else {
  document.getElementById("acceptPrivacy").onclick = () => {
    localStorage.setItem("vc_privacyAccepted", "1");
    privacyOverlay.style.display = "none";
    showSetupIfNeeded();
  };
}

// ─────────────────────────────
// SETUP PROFILE
// ─────────────────────────────
function showSetupIfNeeded() {
  if (!username) {
    setupOverlay.style.display = "flex";
  } else {
    setupOverlay.style.display = "none";
  }
}

// Avatar upload – setup
const avatarUploadArea = document.getElementById("avatarUploadArea");
const avatarFile       = document.getElementById("avatarFile");
const avatarPreview    = document.getElementById("avatarPreview");
const avatarInitial    = document.getElementById("avatarInitial");
const avatarImg        = document.getElementById("avatarImg");

avatarUploadArea.onclick = () => avatarFile.click();

avatarFile.onchange = () => {
  const file = avatarFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    avatarImg.src = e.target.result;
    avatarImg.style.display = "block";
    avatarInitial.style.display = "none";
  };
  reader.readAsDataURL(file);
};

document.getElementById("saveSetup").onclick = () => {
  const name = document.getElementById("setupName").value.trim();
  const err  = document.getElementById("setupError");

  if (!name) {
    err.textContent = "Bitte gib einen Namen ein.";
    return;
  }
  err.textContent = "";

  username = name;
  localStorage.setItem("vc_username", name);

  if (avatarImg.src && avatarImg.style.display !== "none") {
    avatar = avatarImg.src;
    localStorage.setItem("vc_avatar", avatar);
  }

  updateSelfUI();
  setupOverlay.style.display = "none";
};

// ─────────────────────────────
// SETTINGS MODAL
// ─────────────────────────────
document.getElementById("settingsBtn").onclick = () => {
  populateSettings();
  settingsOverlay.style.display = "flex";
};

document.getElementById("closeSettings").onclick = () => {
  settingsOverlay.style.display = "none";
  stopMicTest();
};

// Click outside to close
settingsOverlay.onclick = (e) => {
  if (e.target === settingsOverlay) {
    settingsOverlay.style.display = "none";
    stopMicTest();
  }
};

// Tabs
document.querySelectorAll(".tab").forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.remove("hidden");
  };
});

// Profile tab – avatar
const settingsAvatarArea = document.getElementById("settingsAvatarArea");
const settingsAvatarFile = document.getElementById("settingsAvatarFile");
const settingsAvatarImg  = document.getElementById("settingsAvatarImg");
const settingsAvatarInitial = document.getElementById("settingsAvatarInitial");

settingsAvatarArea.onclick = () => settingsAvatarFile.click();

settingsAvatarFile.onchange = () => {
  const file = settingsAvatarFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    settingsAvatarImg.src = e.target.result;
    settingsAvatarImg.style.display = "block";
    settingsAvatarInitial.style.display = "none";
  };
  reader.readAsDataURL(file);
};

// Color presets
const PROFILE_COLORS = ["#5865f2","#3ba55c","#faa61a","#ed4245","#eb459e","#00d2f7","#f47fff","#ff7f50"];
const ACCENT_COLORS  = ["#5865f2","#3ba55c","#faa61a","#ed4245","#eb459e","#00d2f7","#a855f7","#ff6b35"];

function buildColorSwatches(containerId, colors, currentColor, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = "";
  colors.forEach(c => {
    const sw = document.createElement("div");
    sw.className = `color-swatch${c === currentColor ? " selected" : ""}`;
    sw.style.background = c;
    sw.title = c;
    sw.onclick = () => {
      el.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("selected"));
      sw.classList.add("selected");
      onSelect(c);
    };
    el.appendChild(sw);
  });
}

function populateSettings() {
  // Profile
  document.getElementById("settingsName").value = username;

  if (avatar) {
    settingsAvatarImg.src = avatar;
    settingsAvatarImg.style.display = "block";
    settingsAvatarInitial.style.display = "none";
  } else {
    settingsAvatarInitial.textContent = username ? username[0].toUpperCase() : "?";
    settingsAvatarImg.style.display = "none";
    settingsAvatarInitial.style.display = "flex";
  }

  buildColorSwatches("colorPresets", PROFILE_COLORS, profileColor, (c) => {
    profileColor = c;
    localStorage.setItem("vc_profileColor", c);
  });

  // Banner
  const savedBanner = localStorage.getItem("vc_banner") || "none";
  document.querySelectorAll(".banner-opt").forEach(o => {
    o.classList.toggle("selected", o.dataset.banner === savedBanner);
    o.onclick = () => {
      document.querySelectorAll(".banner-opt").forEach(b => b.classList.remove("selected"));
      o.classList.add("selected");
      localStorage.setItem("vc_banner", o.dataset.banner);
    };
  });

  // Audio
  populateMicList();
  document.getElementById("inputVolume").value    = inputVolume * 100;
  document.getElementById("thresholdSlider").value= threshold;
  document.getElementById("thresholdVal").textContent = threshold;
  document.getElementById("autoMuteToggle").checked = localStorage.getItem("vc_autoMute") === "true";
  document.getElementById("noiseSuppressionToggle").checked = noiseSp;

  // Appearance
  document.getElementById("bgSelect").value      = bgTheme;
  document.getElementById("compactToggle").checked = compact;
  document.getElementById("customBgWrap").style.display = bgTheme === "custom" ? "block" : "none";
  buildColorSwatches("accentPresets", ACCENT_COLORS, accentColor, (c) => {
    accentColor = c;
    localStorage.setItem("vc_accent", c);
    document.documentElement.style.setProperty("--accent", c);
  });
}

// Save profile
document.getElementById("saveProfile").onclick = () => {
  const newName = document.getElementById("settingsName").value.trim();
  if (!newName) return;

  username = newName;
  localStorage.setItem("vc_username", newName);

  if (settingsAvatarImg.style.display !== "none" && settingsAvatarImg.src) {
    avatar = settingsAvatarImg.src;
    localStorage.setItem("vc_avatar", avatar);
  }

  updateSelfUI();
  toast("Profil gespeichert", "success");
};

// Input volume
document.getElementById("inputVolume").oninput = (e) => {
  inputVolume = e.target.value / 100;
  localStorage.setItem("vc_inputVol", inputVolume);
  if (inputGainNode) inputGainNode.gain.value = inputVolume;
};

// Threshold
document.getElementById("thresholdSlider").oninput = (e) => {
  threshold = parseInt(e.target.value);
  document.getElementById("thresholdVal").textContent = threshold;
  localStorage.setItem("vc_threshold", threshold);
};

// Auto-mute
document.getElementById("autoMuteToggle").onchange = (e) => {
  localStorage.setItem("vc_autoMute", e.target.checked);
};

// Noise Suppression
document.getElementById("noiseSuppressionToggle").onchange = (e) => {
  localStorage.setItem("noiseSp", e.target.checked);
};

// Background
document.getElementById("bgSelect").onchange = (e) => {
  bgTheme = e.target.value;
  localStorage.setItem("vc_bg", bgTheme);
  applyTheme();
  document.getElementById("customBgWrap").style.display = bgTheme === "custom" ? "block" : "none";
};

document.getElementById("customBgColor").oninput = (e) => {
  localStorage.setItem("vc_customBg", e.target.value);
  applyTheme();
};

// Compact
document.getElementById("compactToggle").onchange = (e) => {
  compact = e.target.checked;
  localStorage.setItem("vc_compact", compact);
  document.body.classList.toggle("compact", compact);
};

// ── MIC LIST ──────────────────────────────────────────────────────────────────
async function populateMicList() {
  const select = document.getElementById("micSelect");
  select.innerHTML = "";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === "audioinput");
    const savedId = localStorage.getItem("vc_micId");
    mics.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Mikrofon ${d.deviceId.slice(0,6)}`;
      if (d.deviceId === savedId) opt.selected = true;
      select.appendChild(opt);
    });
  } catch(_) {}
}

document.getElementById("micSelect").onchange = (e) => {
  localStorage.setItem("vc_micId", e.target.value);
};

// ── MIC TEST ──────────────────────────────────────────────────────────────────
let testStream = null;
let testInterval = null;

document.getElementById("testMic").onclick = async () => {
  if (testStream) { stopMicTest(); return; }

  try {
    const micId = localStorage.getItem("vc_micId");
    testStream = await navigator.mediaDevices.getUserMedia({
      audio: micId ? { deviceId: { exact: micId } } : true
    });

    const ctx = getOrCreateAudioContext();
    const src = ctx.createMediaStreamSource(testStream);
    const ana = ctx.createAnalyser();
    ana.fftSize = 256;
    src.connect(ana);

    const data = new Uint8Array(ana.frequencyBinCount);
    testInterval = setInterval(() => {
      ana.getByteFrequencyData(data);
      const avg = data.reduce((a,b)=>a+b,0)/data.length;
      const bar = document.getElementById("micMeterBar");
      if (bar) bar.style.width = `${Math.min(avg / 1.28, 100)}%`;
    }, 60);

    document.getElementById("testMic").textContent = "Test stoppen";
    toast("Mikrofon wird getestet…", "info");
  } catch(e) {
    toast("Mikrofon-Zugriff verweigert", "error");
  }
};

function stopMicTest() {
  if (testInterval) { clearInterval(testInterval); testInterval = null; }
  if (testStream) { testStream.getTracks().forEach(t=>t.stop()); testStream = null; }
  const bar = document.getElementById("micMeterBar");
  if (bar) bar.style.width = "0%";
  const btn = document.getElementById("testMic");
  if (btn) btn.textContent = "Mikrofon testen";
}

// ─────────────────────────────
// THEME
// ─────────────────────────────
function applyTheme() {
  document.body.className = "";
  if (bgTheme && bgTheme !== "dark") document.body.classList.add(`theme-${bgTheme}`);
  if (compact) document.body.classList.add("compact");

  if (bgTheme === "custom") {
    const c = localStorage.getItem("vc_customBg") || "#0f0f0f";
    document.documentElement.style.setProperty("--bg-primary", c);
  } else {
    document.documentElement.style.removeProperty("--bg-primary");
  }

  if (accentColor) {
    document.documentElement.style.setProperty("--accent", accentColor);
    // Update accent-rgb
    const hex = accentColor.replace("#","");
    const r = parseInt(hex.slice(0,2),16);
    const g = parseInt(hex.slice(2,4),16);
    const b = parseInt(hex.slice(4,6),16);
    document.documentElement.style.setProperty("--accent-rgb", `${r},${g},${b}`);
  }
}

// ─────────────────────────────
// CONNECTION STATUS
// ─────────────────────────────
function updateConnectionStatus(connected, inChannel) {
  const dot  = connected ? (inChannel ? "online" : "online") : "offline";
  const text = !connected ? "Getrennt" : inChannel ? "Verbunden" : "Verbunden";

  connectionStatus.innerHTML = `
    <span class="status-dot ${dot}"></span>
    <span>${text}</span>
  `;
}

// ─────────────────────────────
// LATENCY PING
// ─────────────────────────────
function pingLoop() {
  setInterval(() => {
    if (!joined) return;
    const t = Date.now();
    socket.emit("ping-latency", t);
  }, 3000);
}

socket.on("pong-latency", (sent) => {
  const rtt = Date.now() - sent;
  latencyBadge.style.display = "flex";
  latencyBadge.textContent = `● ${rtt}ms`;
  latencyBadge.className = "latency-badge" +
    (rtt > 150 ? " lag" : rtt > 300 ? " bad" : "");
});

// ─────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────
function toast(msg, type = "info") {
  const container = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ─────────────────────────────
// SELF UI
// ─────────────────────────────
function updateSelfUI() {
  if (username) {
    selfName.textContent = username;
    selfInitial.textContent = username[0].toUpperCase();
  }

  if (avatar) {
    selfAvatarImg.src = avatar;
    selfAvatarImg.style.display = "block";
    selfInitial.style.display = "none";
  } else {
    selfAvatarImg.style.display = "none";
    selfInitial.style.display = "flex";
  }

  // 🎨 COLOR + GRADIENT ADDON
  const selfArea = document.getElementById("self-area");
  if (selfArea) {
    const c = profileColor || "#5865f2";

    selfArea.style.background = `linear-gradient(135deg, ${c}33, ${c}00)`;
    selfArea.style.border = `1px solid ${c}55`;
  }
}

// ─────────────────────────────
// INIT
// ─────────────────────────────
applyTheme();
updateSelfUI();
showSetupIfNeeded();
setMuteUI(false);
ctrlMute.disabled = true;
updateConnectionStatus(false, false);
