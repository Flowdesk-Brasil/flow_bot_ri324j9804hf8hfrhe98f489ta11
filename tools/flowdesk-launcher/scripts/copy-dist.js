const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
const downloadsDir = path.join(__dirname, "..", "..", "..", "site", "public", "downloads");
const files = ["FlowdeskLauncher-Setup.exe", "latest.yml", "FlowdeskLauncher-Setup.exe.blockmap"];

fs.mkdirSync(downloadsDir, { recursive: true });
for (const fileName of files) {
  const from = path.join(distDir, fileName);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(downloadsDir, fileName));
}
