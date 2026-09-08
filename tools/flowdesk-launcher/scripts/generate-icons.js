const fs = require("fs");
const path = require("path");

async function main() {
  const sharp = require("sharp");
  const pngToIco = require("png-to-ico").default || require("png-to-ico");
  const assetsDir = path.join(__dirname, "..", "assets");
  const rendererAssetsDir = path.join(__dirname, "..", "renderer", "assets");
  const svgPath = path.join(assetsDir, "icon.svg");
  if (!fs.existsSync(svgPath)) {
    throw new Error("assets/icon.svg nao encontrado.");
  }

  fs.mkdirSync(rendererAssetsDir, { recursive: true });
  const sizes = [16, 32, 48, 64, 128, 256, 512];
  const icoParts = [];

  for (const size of sizes) {
    const buffer = await sharp(svgPath).resize(size, size, { fit: "contain" }).png().toBuffer();
    fs.writeFileSync(path.join(assetsDir, `icon-${size}.png`), buffer);
    if ([16, 32, 48, 256].includes(size)) icoParts.push(buffer);
  }

  const icon256 = fs.readFileSync(path.join(assetsDir, "icon-256.png"));
  fs.writeFileSync(path.join(assetsDir, "icon.png"), icon256);
  fs.writeFileSync(path.join(assetsDir, "icon.ico"), await pngToIco(icoParts));
  fs.copyFileSync(path.join(assetsDir, "icon-512.png"), path.join(rendererAssetsDir, "logo.png"));
  fs.copyFileSync(path.join(assetsDir, "icon-32.png"), path.join(rendererAssetsDir, "favicon.png"));

  console.log("Icones gerados em assets/ e renderer/assets/");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
