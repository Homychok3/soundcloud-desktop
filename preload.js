const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  trackPlaying: (payload) => ipcRenderer.send("track-playing", payload),
  trackPaused: (payload) => ipcRenderer.send("track-paused", payload),
  trackStopped: () => ipcRenderer.send("track-stopped"),
  windowControl: (action) => ipcRenderer.send("window-control", action),
  onRpcStatus: (callback) => ipcRenderer.on("rpc-status", (_event, data) => callback(data)),
  onWindowMaximized: (callback) =>
    ipcRenderer.on("window-maximized", (_event, value) => callback(value)),
  settingsGet: () => ipcRenderer.invoke("settings-get"),
  settingsSet: (key, value) => ipcRenderer.send("settings-set", key, value),
  onSettingsChanged: (callback) =>
    ipcRenderer.on("settings-changed", (_event, nextSettings) => callback(nextSettings)),
  rebindHotkey: (action, accelerator) => ipcRenderer.invoke("rebind-hotkey", action, accelerator)
});
