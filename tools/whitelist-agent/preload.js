const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  getState: () => ipcRenderer.invoke("agent:state"),
  save: (payload) => ipcRenderer.invoke("agent:save", payload),
  testDb: () => ipcRenderer.invoke("agent:test-db"),
  syncNow: () => ipcRenderer.invoke("agent:sync"),
  firewall: () => ipcRenderer.invoke("agent:firewall"),
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("agent:state", listener);
    return () => ipcRenderer.removeListener("agent:state", listener);
  },
});
