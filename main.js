const fs = require("fs");
const path = require("path");
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session,
  Tray
} = require("electron");
const RPC = require("discord-rpc");

const defaultSettings = {
  discordClientId: "",
  richPresenceImageKey: "soundcloud_logo",
  soundcloudUrl: "https://soundcloud.com",
  rpc: {
    enabled: true,
    showTimer: true,
    showArtist: true,
    pausedStatus: "show_paused"
  },
  notifications: {
    enabled: true,
    style: "full"
  },
  hotkeys: {
    playPause: "MediaPlayPause",
    nextTrack: "MediaNextTrack",
    prevTrack: "MediaPreviousTrack",
    likeTrack: "Ctrl+L",
    muteToggle: "Ctrl+M",
    toggleWindow: "Ctrl+Shift+S"
  },
  ui: {
    titlebarHeight: "normal",
    coverArt: true,
    startMinimized: false,
    autoLaunch: false,
    language: "ru",
    alwaysOnTop: false,
    rememberLastPage: true,
    focusMode: false,
    theme: "ember",
    brandName: "SoundCloud Desktop",
    nickname: "Desktop User"
  },
  privacy: {
    blockAds: true
  },
  state: {
    lastUrl: "https://soundcloud.com"
  }
};

const SOUNDCLOUD_PARTITION = "persist:soundcloud";
let sessionHooksRegistered = false;

app.commandLine.appendSwitch("ignore-certificate-errors");
app.commandLine.appendSwitch("ignore-ssl-errors");
app.commandLine.appendSwitch("allow-insecure-localhost");
app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");

let mainWindow = null;
let tray = null;
let rpc = null;
let rpcReady = false;
let reconnectTimer = null;
let settings = clone(defaultSettings);
let currentTrack = null;
let lastActivityKey = "";
let lastNotifiedTitle = "";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeSettings(base, loaded) {
  const output = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(loaded || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      output[key] = mergeSettings(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf8");
    settings = mergeSettings(clone(defaultSettings), JSON.parse(raw));
  } catch (err) {
    settings = clone(defaultSettings);
  }
  return settings;
}

function saveSettings(nextSettings) {
  settings = mergeSettings(clone(defaultSettings), nextSettings);
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
  return settings;
}

function setDeepValue(target, dottedKey, value) {
  const parts = dottedKey.split(".");
  let ref = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!ref[part] || typeof ref[part] !== "object") {
      ref[part] = {};
    }
    ref = ref[part];
  }
  ref[parts[parts.length - 1]] = value;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendRpcStatus(status, details) {
  sendToRenderer("rpc-status", { status, details });
}

function sendSettingsChanged() {
  sendToRenderer("settings-changed", settings);
}

function truncate(text) {
  if (!text) return "";
  return text.length > 128 ? `${text.slice(0, 125)}...` : text;
}

function normalizeArtworkUrl(url) {
  if (!url) return "";
  return url.replace(/-(t\d+x\d+|large|badge|crop)\./i, "-t500x500.");
}

function buildActivity({ title, artist, state, durationSec, elapsedSec, artworkUrl }) {
  if (!title || !settings.rpc.enabled) return null;
  if (state === "paused" && settings.rpc.pausedStatus === "clear") return null;

  const largeImage = normalizeArtworkUrl(artworkUrl) || settings.richPresenceImageKey || "soundcloud_logo";
  const activity = {
    details: truncate(title),
    largeImageKey: largeImage,
    largeImageText: truncate(title) || "SoundCloud",
    instance: false
  };

  if (state === "playing") {
    activity.smallImageText = "Играет";

    if (settings.rpc.showArtist && artist) {
      activity.state = truncate(artist);
    }

    if (settings.rpc.showTimer && durationSec > 0) {
      const safeElapsed = Math.max(0, Math.min(elapsedSec || 0, durationSec));
      const nowSec = Math.floor(Date.now() / 1000);
      activity.startTimestamp = nowSec - safeElapsed;
      activity.endTimestamp = nowSec + Math.max(durationSec - safeElapsed, 0);
    }
  } else {
    activity.smallImageText = "Пауза";
    activity.state = settings.rpc.showArtist && artist
      ? truncate(`Пауза • ${artist}`)
      : "Пауза";
  }

  return activity;
}

function getActivityKey(track) {
  if (!track) return "";
  return JSON.stringify({
    title: track.title || "",
    artist: settings.rpc.showArtist ? track.artist || "" : "",
    state: track.state || "",
    artworkUrl: track.artworkUrl || "",
    durationSec: settings.rpc.showTimer ? track.durationSec || 0 : 0,
    pausedStatus: settings.rpc.pausedStatus,
    enabled: settings.rpc.enabled,
    imageKey: settings.richPresenceImageKey || ""
  });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function destroyRpc() {
  if (!rpc) {
    rpcReady = false;
    return;
  }

  const client = rpc;
  rpc = null;
  rpcReady = false;
  client.removeAllListeners();

  if (typeof client.destroy === "function") {
    try {
      client.destroy();
    } catch (err) {
      console.error("Discord RPC destroy error:", err);
    }
  }
}

function scheduleReconnect(reason) {
  if (app.isQuitting || reconnectTimer || !settings.rpc.enabled || !settings.discordClientId) {
    return;
  }
  sendRpcStatus("reconnecting", reason || "Повторное подключение через 15 секунд");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initDiscordRpc();
  }, 15000);
}

function syncRpcActivity(force = false) {
  if (!rpcReady || !rpc) return;

  const activity = buildActivity(currentTrack || {});
  if (!activity) {
    lastActivityKey = "";
    rpc.clearActivity().catch(() => {});
    return;
  }

  const key = getActivityKey(currentTrack);
  if (!force && key === lastActivityKey) return;

  lastActivityKey = key;
  rpc.setActivity(activity).catch((err) => {
    console.error("setActivity error:", err);
  });
}

function initDiscordRpc() {
  clearReconnectTimer();
  destroyRpc();
  lastActivityKey = "";

  if (!settings.rpc.enabled) {
    sendRpcStatus("disabled", "Discord RPC выключен в настройках");
    return;
  }

  if (!settings.discordClientId) {
    sendRpcStatus("needs_config", "Укажи Discord Client ID в настройках");
    return;
  }

  RPC.register(settings.discordClientId);
  rpc = new RPC.Client({ transport: "ipc" });
  sendRpcStatus("connecting");

  rpc.on("ready", () => {
    rpcReady = true;
    sendRpcStatus("connected");
    syncRpcActivity(true);
  });

  rpc.on("disconnected", () => {
    destroyRpc();
    sendRpcStatus("disconnected", "Discord IPC disconnected");
    scheduleReconnect("Discord IPC disconnected");
  });

  rpc.on("error", (err) => {
    const message = err && err.message ? err.message : "Discord RPC error";
    destroyRpc();
    sendRpcStatus("error", message);
    scheduleReconnect(message);
  });

  rpc.login({ clientId: settings.discordClientId }).catch((err) => {
    const message = err && err.message ? err.message : "Discord login failed";
    destroyRpc();
    sendRpcStatus("error", message);
    scheduleReconnect(message);
  });
}

function createAppIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ff5500"/>
          <stop offset="100%" stop-color="#ff8c00"/>
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="#101014"/>
      <rect x="8" y="8" width="48" height="48" rx="14" fill="url(#g)"/>
      <path fill="#fff" d="M18 37.5c0 2.2 1.8 4 4 4s4-1.8 4-4v-11c0-2.2-1.8-4-4-4s-4 1.8-4 4v11zm10 4.5c0 2.2 1.8 4 4 4s4-1.8 4-4V21c0-2.2-1.8-4-4-4s-4 1.8-4 4v21zm10-2.5c0 2.2 1.8 4 4 4s4-1.8 4-4V26c0-2.2-1.8-4-4-4s-4 1.8-4 4v13z"/>
    </svg>
  `;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function executeInWebview(script) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);

  return mainWindow.webContents.executeJavaScript(
    `(async () => {
      const webview = document.getElementById("scView");
      if (!webview) return false;
      return webview.executeJavaScript(${JSON.stringify(script)}, true);
    })();`,
    true
  );
}

function playPauseTrack() {
  return executeInWebview(`
    (() => {
      const button = document.querySelector(".playControls__play");
      if (!button) return false;
      button.click();
      return true;
    })();
  `);
}

function nextTrack() {
  return executeInWebview(`
    (() => {
      const button = document.querySelector(".skipControl__next");
      if (!button) return false;
      button.click();
      return true;
    })();
  `);
}

function prevTrack() {
  return executeInWebview(`
    (() => {
      const button = document.querySelector(".skipControl__previous");
      if (!button) return false;
      button.click();
      return true;
    })();
  `);
}

function likeTrack() {
  return executeInWebview(`
    (() => {
      const button = document.querySelector(".playbackSoundBadge__like");
      if (!button) return false;
      button.click();
      return true;
    })();
  `);
}

function toggleMute() {
  return executeInWebview(`
    (() => {
      const button = document.querySelector(".volume__button");
      if (!button) return false;
      button.click();
      return true;
    })();
  `);
}

function toggleWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function registerHotkeys(hotkeys) {
  if (!app.isReady()) return;
  globalShortcut.unregisterAll();

  const bindings = [
    ["playPause", hotkeys.playPause, playPauseTrack],
    ["nextTrack", hotkeys.nextTrack, nextTrack],
    ["prevTrack", hotkeys.prevTrack, prevTrack],
    ["likeTrack", hotkeys.likeTrack, likeTrack],
    ["muteToggle", hotkeys.muteToggle, toggleMute],
    ["toggleWindow", hotkeys.toggleWindow, toggleWindowVisibility]
  ];

  for (const [name, accelerator, callback] of bindings) {
    if (!accelerator) continue;
    try {
      const ok = globalShortcut.register(accelerator, callback);
      if (!ok) {
        console.error(`Failed to register hotkey: ${name} -> ${accelerator}`);
      }
    } catch (err) {
      console.error(`Invalid hotkey: ${name} -> ${accelerator}`, err);
    }
  }
}

function showTrackNotification(title, artist) {
  if (!settings.notifications?.enabled) return;
  if (!Notification.isSupported()) return;

  const body = settings.notifications?.style === "minimal" ? "" : (artist || "");
  const notification = new Notification({
    title,
    body,
    icon: createAppIcon(),
    silent: true
  });
  notification.show();
}

function updateTrayMenu() {
  if (!tray) return;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Открыть",
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: "Play / Pause",
        click: () => {
          playPauseTrack();
        }
      },
      { type: "separator" },
      {
        label: "Выход",
        click: () => app.quit()
      }
    ])
  );
}

function updateTrayTooltip(trackTitle) {
  if (!tray) return;
  tray.setToolTip(trackTitle || "SoundCloud Desktop");
}

function syncAutoLaunch() {
  if (!app.isReady()) return;
  app.setLoginItemSettings({
    openAtLogin: !!settings.ui?.autoLaunch,
    path: process.execPath
  });
}

function syncWindowPreferences() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(!!settings.ui?.alwaysOnTop, "screen-saver");
}

function shouldBlockRequest(url) {
  if (!settings.privacy?.blockAds) return false;
  const blockers = [
    "doubleclick.net",
    "googlesyndication.com",
    "adservice.google.com",
    "ads-twitter.com",
    "amazon-adsystem.com",
    "adtng.com",
    "branch.io",
    "crashlytics.com",
    "sentry.io",
    "google-analytics.com",
    "googletagmanager.com",
    "facebook.net",
    "analytics",
    "pixel"
  ];
  return blockers.some((part) => url.includes(part));
}

function registerPersistentSession() {
  if (sessionHooksRegistered) return;
  const scSession = session.fromPartition(SOUNDCLOUD_PARTITION);
  scSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission !== "notifications");
  });
  scSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: shouldBlockRequest(details.url) });
  });
  sessionHooksRegistered = true;
}

function createTray() {
  tray = new Tray(createAppIcon().resize({ width: 18, height: 18 }));
  updateTrayMenu();
  updateTrayTooltip(currentTrack?.title || "");
  tray.on("click", () => {
    toggleWindowVisibility();
  });
}

function handleTrackUpdate(payload, state) {
  currentTrack = {
    title: payload.title || "",
    artist: payload.artist || "",
    state,
    durationSec: Number.isFinite(payload.durationSec) ? payload.durationSec : 0,
    elapsedSec: Number.isFinite(payload.elapsedSec) ? payload.elapsedSec : 0,
    artworkUrl: payload.artworkUrl || ""
  };

  if (currentTrack.title && currentTrack.title !== lastNotifiedTitle) {
    lastNotifiedTitle = currentTrack.title;
    showTrackNotification(currentTrack.title, currentTrack.artist);
  }

  updateTrayTooltip(currentTrack.title);
  syncRpcActivity();
}

function clearTrack() {
  currentTrack = null;
  lastActivityKey = "";
  lastNotifiedTitle = "";
  updateTrayTooltip("");
  if (rpcReady && rpc) {
    rpc.clearActivity().catch(() => {});
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: !settings.ui.startMinimized,
    frame: false,
    backgroundColor: "#090909",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      webSecurity: false
    }
  });

  mainWindow.loadFile("index.html");
  syncWindowPreferences();

  mainWindow.on("maximize", () => sendToRenderer("window-maximized", true));
  mainWindow.on("unmaximize", () => sendToRenderer("window-maximized", false));
  mainWindow.on("ready-to-show", () => {
    if (!settings.ui.startMinimized) {
      mainWindow.show();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    callback(true);
  });

  loadSettings();
  registerPersistentSession();
  syncAutoLaunch();
  createWindow();
  createTray();
  registerHotkeys(settings.hotkeys);
  initDiscordRpc();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
  clearReconnectTimer();
  globalShortcut.unregisterAll();
  destroyRpc();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.on("window-control", (event, action) => {
  if (!mainWindow) return;
  if (action === "minimize") mainWindow.minimize();
  if (action === "maximize") {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
  if (action === "close") mainWindow.close();
});

ipcMain.on("track-playing", (event, payload) => {
  handleTrackUpdate(payload || {}, "playing");
});

ipcMain.on("track-paused", (event, payload) => {
  handleTrackUpdate(payload || {}, "paused");
});

ipcMain.on("track-stopped", () => {
  clearTrack();
});

ipcMain.handle("settings-get", () => {
  return settings;
});

ipcMain.on("settings-set", (event, key, value) => {
  const nextSettings = clone(settings);
  setDeepValue(nextSettings, key, value);
  saveSettings(nextSettings);

  if (key === "rpc.enabled" || key === "discordClientId") {
    initDiscordRpc();
  } else if (key.startsWith("rpc.") || key === "richPresenceImageKey") {
    lastActivityKey = "";
    syncRpcActivity(true);
  }

  if (key === "ui.autoLaunch") {
    syncAutoLaunch();
  }

  if (key === "ui.alwaysOnTop") {
    syncWindowPreferences();
  }

  if (key === "hotkeys" || key.startsWith("hotkeys.")) {
    registerHotkeys(settings.hotkeys);
  }

  sendSettingsChanged();
});

ipcMain.handle("rebind-hotkey", (event, action, accelerator) => {
  if (!action || !accelerator) {
    return { ok: false, error: "Missing action or accelerator" };
  }

  const nextSettings = clone(settings);
  if (!nextSettings.hotkeys) nextSettings.hotkeys = {};
  nextSettings.hotkeys[action] = accelerator;
  saveSettings(nextSettings);
  registerHotkeys(settings.hotkeys);
  sendSettingsChanged();
  return { ok: true };
});
