const socket = io();

// ─────────────────────────────
// STATE
// ─────────────────────────────
let localStream = null;
let muted = false;
let joined = false;

let username = localStorage.getItem("username");
let avatar = localStorage.getItem("avatar");

// ─────────────────────────────
// DOM MAIN
// ─────────────────────────────
const privacyOverlay = document.getElementById("privacyOverlay");
const setupOverlay = document.getElementById("setupOverlay");
const settingsOverlay = document.getElementById("settingsOverlay");

const participantsEl = document.getElementById("participants");
const emptyState = document.getElementById("emptyState");

const joinBtn = document.getElementById("joinBtn");
const leaveBtn = document.getElementById("leaveBtn");

const ctrlMute = document.getElementById("ctrlMute");
const muteBtn = document.getElementById("muteBtn");

const micIcon = document.getElementById("micIcon");
const mutedIcon = document.getElementById("mutedIcon");

const ctrlMicIcon = document.getElementById("ctrlMicIcon");
const ctrlMutedIcon = document.getElementById("ctrlMutedIcon");

const selfName = document.getElementById("selfName");
const selfStatus = document.getElementById("selfStatus");
const selfInitial = document.getElementById("selfInitial");
const selfAvatarImg = document.getElementById("selfAvatarImg");

const connectionStatus = document.getElementById("connectionStatus");

// ─────────────────────────────
// INIT UI
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
// SETUP PROFILE
// ─────────────────────────────
document.getElementById("saveSetup").onclick = () => {
  const name = document.getElementById("setupName").value.trim();
  const file = document.getElementById("avatarFile").files[0];

  if (!name) return;

  const finish = (img) => {
    localStorage.setItem("username", name);
    username = name;

    if (img) {
      localStorage.setItem("avatar", img);
      avatar = img;
    }

    updateSelfUI();
    setupOverlay.style.display = "none";
  };

  if (!file) return finish(null);

  const reader = new FileReader();
  reader.onload = () => finish(reader.result);
  reader.readAsDataURL(file);
};

// Avatar click
document.getElementById("avatarUploadArea").onclick = () => {
  document.getElementById("avatarFile").click();
};

// ─────────────────────────────
// SETTINGS MODAL + TABS
// ─────────────────────────────
document.getElementById("settingsBtn").onclick = () => {
  settingsOverlay.style.display = "flex";
};

document.getElementById("closeSettings").onclick = () => {
  settingsOverlay.style.display = "none";
};

document.querySelectorAll(".tab").forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));

    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.remove("hidden");
  };
});

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
    alert("Mikrofon nicht erlaubt");
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
// MUTE SYSTEM
// ─────────────────────────────
function setMuteUI(state) {
  muted = state;

  if (localStream) {
    localStream.getAudioTracks().forEach(t => {
      t.enabled = !state;
    });
  }

  // bottom control
  ctrlMicIcon.style.display = state ? "none" : "block";
  ctrlMutedIcon.style.display = state ? "block" : "none";

  // top control
  micIcon.style.display = state ? "none" : "block";
  mutedIcon.style.display = state ? "block" : "none";
}

ctrlMute.onclick = () => {
  setMuteUI(!muted);
  socket.emit("mute-state", muted);
};

muteBtn.onclick = () => {
  setMuteUI(!muted);
  socket.emit("mute-state", muted);
};

// ─────────────────────────────
// USERS RENDER
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

          ${u.muted ? `<div class="participant-muted-badge">🔇</div>` : ""}
        </div>

        <div class="participant-name">${u.username}</div>
        <div class="participant-status ${u.speaking ? "speaking-label" : ""}">
          ${u.speaking ? "spricht..." : "idle"}
        </div>
      </div>
    `;
  }
}

// ─────────────────────────────
// SOCKET
// ─────────────────────────────
socket.on("users", renderUsers);

// ─────────────────────────────
// INIT
// ─────────────────────────────
updateSelfUI();
showSetupIfNeeded();

setMuteUI(false);
ctrlMute.disabled = true;
