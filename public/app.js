const socket = io();

// ─────────────────────────────
// State
// ─────────────────────────────
let localStream = null;
let muted = false;
let joined = false;

let username = localStorage.getItem("username");
let avatar = localStorage.getItem("avatar");

// ─────────────────────────────
// DOM
// ─────────────────────────────
const privacyOverlay = document.getElementById("privacyOverlay");
const setupOverlay = document.getElementById("setupOverlay");
const participantsEl = document.getElementById("participants");
const emptyState = document.getElementById("emptyState");

const joinBtn = document.getElementById("joinBtn");
const leaveBtn = document.getElementById("leaveBtn");

const ctrlMute = document.getElementById("ctrlMute");
const micIcon = document.getElementById("ctrlMicIcon");
const mutedIcon = document.getElementById("ctrlMutedIcon");

const selfName = document.getElementById("selfName");
const selfStatus = document.getElementById("selfStatus");
const selfInitial = document.getElementById("selfInitial");
const selfAvatarImg = document.getElementById("selfAvatarImg");

const connectionStatus = document.getElementById("connectionStatus");

// ─────────────────────────────
// INIT UI STATES
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
  }
}

function showSetupIfNeeded() {
  if (!username || !avatar) {
    setupOverlay.style.display = "flex";
  } else {
    setupOverlay.style.display = "none";
  }
}

// ─────────────────────────────
// PRIVACY
// ─────────────────────────────
document.getElementById("acceptPrivacy").onclick = () => {
  privacyOverlay.style.display = "none";
};

// ─────────────────────────────
// SETUP (Profil speichern)
// ─────────────────────────────
document.getElementById("saveSetup").onclick = () => {
  const name = document.getElementById("setupName").value.trim();
  const file = document.getElementById("avatarFile").files[0];

  if (!name) {
    document.getElementById("setupError").textContent = "Name fehlt";
    return;
  }

  if (!file) {
    localStorage.setItem("username", name);
    username = name;
    updateSelfUI();
    setupOverlay.style.display = "none";
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    localStorage.setItem("username", name);
    localStorage.setItem("avatar", reader.result);

    username = name;
    avatar = reader.result;

    updateSelfUI();
    setupOverlay.style.display = "none";
  };

  reader.readAsDataURL(file);
};

// Avatar click
document.getElementById("avatarUploadArea").onclick = () => {
  document.getElementById("avatarFile").click();
};

// ─────────────────────────────
// JOIN / LEAVE
// ─────────────────────────────
joinBtn.onclick = async () => {
  if (joined) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    socket.emit("join", {
      username,
      avatar
    });

    joined = true;

    joinBtn.style.display = "none";
    leaveBtn.style.display = "inline-flex";
    ctrlMute.disabled = false;

    selfStatus.textContent = "Verbunden";
    connectionStatus.innerHTML = `
      <span class="status-dot online"></span>
      <span>Verbunden</span>
    `;
  } catch (e) {
    console.error(e);
    alert("Mikrofon-Zugriff verweigert");
  }
};

leaveBtn.onclick = () => {
  socket.emit("leave");

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }

  joined = false;

  joinBtn.style.display = "inline-flex";
  leaveBtn.style.display = "none";
  ctrlMute.disabled = true;

  participantsEl.innerHTML = "";
  emptyState.style.display = "flex";

  selfStatus.textContent = "Offline";
  connectionStatus.innerHTML = `
    <span class="status-dot offline"></span>
    <span>Getrennt</span>
  `;
};

// ─────────────────────────────
// MUTE
// ─────────────────────────────
function setMuteUI(state) {
  muted = state;

  if (muted) {
    micIcon.style.display = "none";
    mutedIcon.style.display = "block";
  } else {
    micIcon.style.display = "block";
    mutedIcon.style.display = "none";
  }
}

ctrlMute.onclick = () => {
  if (!localStream) return;

  muted = !muted;

  localStream.getAudioTracks().forEach(t => {
    t.enabled = !muted;
  });

  socket.emit("mute-state", muted);
  setMuteUI(muted);
};

// ─────────────────────────────
// PARTICIPANTS RENDER
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
    participantsEl.innerHTML += `
      <div class="participant ${u.speaking ? "speaking" : ""}">
        <div class="participant-avatar-wrap">
          <div class="participant-avatar">
            ${
              u.avatar
                ? `<img src="${u.avatar}">`
                : `<span>${(u.username || "?")[0].toUpperCase()}</span>`
            }
          </div>
          ${
            u.muted
              ? `<div class="participant-muted-badge">🔇</div>`
              : ""
          }
        </div>

        <div class="participant-name">${u.username}</div>

        <div class="participant-status ${
          u.speaking ? "speaking-label" : ""
        }">
          ${u.speaking ? "spricht..." : "idle"}
        </div>
      </div>
    `;
  }
}

// ─────────────────────────────
// SOCKET EVENTS
// ─────────────────────────────
socket.on("connect", () => {
  console.log("connected");
});

socket.on("users", (users) => {
  renderUsers(users);
});

socket.on("user-joined", () => {
  // optional toast later
});

socket.on("user-left", () => {
  // handled by users refresh
});

socket.on("speaking", ({ id, speaking }) => {
  const el = [...document.querySelectorAll(".participant")][0];
  // simple refresh (server already sends full state via users)
});

socket.on("mute-state", ({ id, muted }) => {
  // handled via users refresh
});

// ─────────────────────────────
// INIT
// ─────────────────────────────
updateSelfUI();
showSetupIfNeeded();

setMuteUI(false);
ctrlMute.disabled = true;
