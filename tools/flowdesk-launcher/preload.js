const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flowdesk", {
  getState: () => ipcRenderer.invoke("launcher:state"),
  startLogin: () => ipcRenderer.invoke("launcher:login"),
  bindServer: (guildId) => ipcRenderer.invoke("launcher:bind", guildId),
  logout: () => ipcRenderer.invoke("launcher:logout"),
  openFirewall: () => ipcRenderer.invoke("launcher:firewall"),
  openLogin: () => ipcRenderer.invoke("launcher:open-login"),
  installUpdate: () => ipcRenderer.invoke("launcher:install-update"),
  minimize: () => ipcRenderer.send("launcher:minimize"),
  close: () => ipcRenderer.send("launcher:close"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("launcher:state", listener);
    return () => ipcRenderer.removeListener("launcher:state", listener);
  },
});
