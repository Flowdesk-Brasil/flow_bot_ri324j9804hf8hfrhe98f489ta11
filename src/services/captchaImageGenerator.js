const { createCanvas } = require("@napi-rs/canvas");

const WIDTH = 720;
const HEIGHT = 180;
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
  gradient.addColorStop(0, "#0b0f17");
  gradient.addColorStop(0.55, "#111827");
  gradient.addColorStop(1, "#0a0e14");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = ctx.createRadialGradient(
    WIDTH * 0.5,
    HEIGHT * 0.45,
    8,
    WIDTH * 0.5,
    HEIGHT * 0.45,
    WIDTH * 0.55,
  );
  glow.addColorStop(0, "rgba(148,163,184,0.07)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawNoise(ctx) {
  for (let index = 0; index < 150; index += 1) {
    ctx.fillStyle = `rgba(255,255,255,${randomFloat(0.015, 0.05)})`;
    ctx.fillRect(randomInt(0, WIDTH), randomInt(0, HEIGHT), 1, 1);
  }
}

function drawInterferenceLines(ctx) {
  for (let index = 0; index < 3; index += 1) {
    const baseY = randomInt(22, HEIGHT - 22);
    ctx.beginPath();
    ctx.strokeStyle = `rgba(203,213,225,${randomFloat(0.08, 0.16)})`;
    ctx.lineWidth = randomFloat(0.9, 1.5);
    ctx.moveTo(0, baseY);

    for (let x = 0; x <= WIDTH; x += 12) {
      ctx.lineTo(
        x,
        baseY + Math.sin((x + index * 41) * 0.05) * randomInt(9, 20),
      );
    }

    ctx.stroke();
  }
}

function drawCharacter(ctx, char, centerX, centerY) {
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(randomFloat(-0.32, 0.32));
  ctx.transform(
    1,
    randomFloat(-0.28, 0.28),
    randomFloat(-0.16, 0.16),
    randomFloat(0.84, 1.1),
    0,
    0,
  );

  const fontSize = randomInt(52, 60);
  const tone = randomInt(228, 248);
  ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = `rgba(${tone}, ${tone + randomInt(-4, 2)}, ${tone + randomInt(-2, 4)}, ${randomFloat(0.88, 0.98)})`;
  ctx.shadowColor = "rgba(255,255,255,0.08)";
  ctx.shadowBlur = 6;
  ctx.fillText(char, randomInt(-3, 3), randomInt(-4, 4));
  ctx.shadowColor = "transparent";
  ctx.restore();
}

function applyWaveDistortion(ctx) {
  const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  const source = new Uint8ClampedArray(imageData.data);
  const output = ctx.createImageData(WIDTH, HEIGHT);
  const amplitudeX = randomFloat(4.8, 7.2);
  const amplitudeY = randomFloat(2.2, 4);
  const frequencyX = randomFloat(0.045, 0.065);
  const frequencyY = randomFloat(0.038, 0.052);

  for (let y = 0; y < HEIGHT; y += 1) {
    const offsetX = Math.round(Math.sin(y * frequencyX) * amplitudeX);

    for (let x = 0; x < WIDTH; x += 1) {
      const offsetY = Math.round(Math.sin(x * frequencyY) * amplitudeY);
      const sourceX = Math.min(WIDTH - 1, Math.max(0, x + offsetX));
      const sourceY = Math.min(HEIGHT - 1, Math.max(0, y + offsetY));
      const sourceIndex = (sourceY * WIDTH + sourceX) * 4;
      const targetIndex = (y * WIDTH + x) * 4;

      output.data[targetIndex] = source[sourceIndex];
      output.data[targetIndex + 1] = source[sourceIndex + 1];
      output.data[targetIndex + 2] = source[sourceIndex + 2];
      output.data[targetIndex + 3] = source[sourceIndex + 3];
    }
  }

  ctx.putImageData(output, 0, 0);
}

function drawVignette(ctx) {
  const vignette = ctx.createRadialGradient(
    WIDTH / 2,
    HEIGHT / 2,
    WIDTH * 0.15,
    WIDTH / 2,
    HEIGHT / 2,
    WIDTH * 0.72,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function renderCaptchaImage(code) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const chars = normalizeCaptchaCode(code).split("");

  drawBackground(ctx);

  const gap = chars.length > 5 ? 96 : 108;
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
  drawVignette(ctx);

  return canvas.toBuffer("image/png");
}

module.exports = {
  CHARSET,
  normalizeCaptchaCode,
  generateCaptchaCode,
  generateCaptchaOptions,
  renderCaptchaImage,
};
