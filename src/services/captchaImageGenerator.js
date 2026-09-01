const { createCanvas } = require("@napi-rs/canvas");

const WIDTH = 360;
const HEIGHT = 120;
const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function normalizeCaptchaCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function generateCaptchaCode(length = 5) {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += CHARSET[randomInt(0, CHARSET.length - 1)];
  }
  return code;
}

function generateCaptchaOptions(correctCode, totalOptions = 5) {
  const normalizedCorrect = normalizeCaptchaCode(correctCode);
  const options = new Set([normalizedCorrect]);

  while (options.size < totalOptions) {
    options.add(generateCaptchaCode(normalizedCorrect.length || 5));
  }

  return Array.from(options).sort(() => Math.random() - 0.5);
}

function drawBackground(ctx) {
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, "#fafbfc");
  gradient.addColorStop(1, "#eef2f7");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawNoise(ctx) {
  for (let index = 0; index < 120; index += 1) {
    ctx.fillStyle = `rgba(15,23,42,${randomFloat(0.02, 0.07)})`;
    ctx.fillRect(randomInt(0, WIDTH), randomInt(0, HEIGHT), 1, 1);
  }
}

function drawInterferenceLines(ctx) {
  for (let index = 0; index < 3; index += 1) {
    const baseY = randomInt(24, HEIGHT - 24);
    ctx.beginPath();
    ctx.strokeStyle = `rgba(${randomInt(60, 120)}, ${randomInt(80, 140)}, ${randomInt(120, 180)}, ${randomFloat(0.18, 0.32)})`;
    ctx.lineWidth = randomFloat(1, 1.8);
    ctx.moveTo(0, baseY);

    for (let x = 0; x <= WIDTH; x += 14) {
      ctx.lineTo(
        x,
        baseY + Math.sin((x + index * 37) * 0.045) * randomInt(6, 14),
      );
    }

    ctx.stroke();
  }
}

function drawCharacter(ctx, char, centerX, centerY) {
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(randomFloat(-0.28, 0.28));
  ctx.transform(
    1,
    randomFloat(-0.22, 0.22),
    randomFloat(-0.12, 0.12),
    randomFloat(0.88, 1.08),
    0,
    0,
  );

  const fontSize = randomInt(40, 46);
  ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = `rgb(${randomInt(24, 42)}, ${randomInt(32, 52)}, ${randomInt(48, 72)})`;
  ctx.fillText(char, randomInt(-2, 2), randomInt(-3, 3));
  ctx.restore();
}

function applyWaveDistortion(ctx) {
  const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  const source = new Uint8ClampedArray(imageData.data);
  const output = ctx.createImageData(WIDTH, HEIGHT);
  const amplitude = randomFloat(2.2, 3.8);
  const frequency = randomFloat(0.04, 0.06);

  for (let y = 0; y < HEIGHT; y += 1) {
    const offsetX = Math.round(Math.sin(y * frequency) * amplitude);

    for (let x = 0; x < WIDTH; x += 1) {
      const sourceX = Math.min(WIDTH - 1, Math.max(0, x + offsetX));
      const sourceIndex = (y * WIDTH + sourceX) * 4;
      const targetIndex = (y * WIDTH + x) * 4;

      output.data[targetIndex] = source[sourceIndex];
      output.data[targetIndex + 1] = source[sourceIndex + 1];
      output.data[targetIndex + 2] = source[sourceIndex + 2];
      output.data[targetIndex + 3] = source[sourceIndex + 3];
    }
  }

  ctx.putImageData(output, 0, 0);
}

function renderCaptchaImage(code) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const chars = normalizeCaptchaCode(code).split("");

  drawBackground(ctx);

  const gap = chars.length > 5 ? 52 : 58;
  const totalWidth = (chars.length - 1) * gap;
  const startX = WIDTH / 2 - totalWidth / 2;
  const centerY = HEIGHT / 2 + randomInt(-2, 2);

  chars.forEach((char, index) => {
    drawCharacter(ctx, char, startX + index * gap, centerY);
  });

  drawInterferenceLines(ctx);
  drawNoise(ctx);
  applyWaveDistortion(ctx);
  drawInterferenceLines(ctx);

  return canvas.toBuffer("image/png");
}

module.exports = {
  CHARSET,
  normalizeCaptchaCode,
  generateCaptchaCode,
  generateCaptchaOptions,
  renderCaptchaImage,
};
