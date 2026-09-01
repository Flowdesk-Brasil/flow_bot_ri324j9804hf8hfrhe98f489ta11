const { createCanvas } = require("@napi-rs/canvas");

const WIDTH = 640;
const HEIGHT = 220;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomColor(min = 40, max = 210) {
  return `rgb(${randomInt(min, max)}, ${randomInt(min, max)}, ${randomInt(min, max)})`;
}

function generateCaptchaCode(length = 6) {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += String(randomInt(0, 9));
  }
  return code;
}

function generateCaptchaOptions(correctCode, totalOptions = 5) {
  const options = new Set([correctCode]);
  while (options.size < totalOptions) {
    options.add(generateCaptchaCode(correctCode.length));
  }
  return Array.from(options).sort(() => Math.random() - 0.5);
}

function drawNoise(ctx) {
  for (let index = 0; index < 120; index += 1) {
    ctx.strokeStyle = randomColor(80, 200);
    ctx.lineWidth = randomInt(1, 2);
    ctx.beginPath();
    ctx.moveTo(randomInt(0, WIDTH), randomInt(0, HEIGHT));
    ctx.lineTo(randomInt(0, WIDTH), randomInt(0, HEIGHT));
    ctx.stroke();
  }

  for (let index = 0; index < 900; index += 1) {
    ctx.fillStyle = randomColor(90, 220);
    ctx.fillRect(randomInt(0, WIDTH), randomInt(0, HEIGHT), 2, 2);
  }
}

function renderCaptchaImage(code) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, "#0b1020");
  gradient.addColorStop(0.55, "#111827");
  gradient.addColorStop(1, "#0f172a");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  drawNoise(ctx);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const chars = String(code).split("");
  const startX = WIDTH / 2 - ((chars.length - 1) * 56) / 2;

  chars.forEach((char, index) => {
    const x = startX + index * 56 + randomInt(-6, 6);
    const y = HEIGHT / 2 + randomInt(-10, 10);
    const rotation = (randomInt(-18, 18) * Math.PI) / 180;
    const fontSize = randomInt(44, 54);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.font = `700 ${fontSize}px Arial`;
    ctx.fillStyle = randomColor(180, 255);
    ctx.fillText(char, 0, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1.2;
    ctx.strokeText(char, 0, 0);
    ctx.restore();
  });

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, WIDTH - 16, HEIGHT - 16);

  return canvas.toBuffer("image/png");
}

module.exports = {
  generateCaptchaCode,
  generateCaptchaOptions,
  renderCaptchaImage,
};
