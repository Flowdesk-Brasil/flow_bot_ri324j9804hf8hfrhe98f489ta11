const { createCanvas } = require("@napi-rs/canvas");

const WIDTH = 720;
const HEIGHT = 200;
const PADDING = 22;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function hsla(h, s, l, a) {
  return `hsla(${h}, ${s}%, ${l}%, ${a})`;
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

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawBackground(ctx) {
  const baseGradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  baseGradient.addColorStop(0, "#070b14");
  baseGradient.addColorStop(0.45, "#10172a");
  baseGradient.addColorStop(1, "#0a1020");
  ctx.fillStyle = baseGradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glows = [
    { x: WIDTH * 0.18, y: HEIGHT * 0.42, radius: 150, hue: 238 },
    { x: WIDTH * 0.82, y: HEIGHT * 0.58, radius: 130, hue: 265 },
    { x: WIDTH * 0.52, y: HEIGHT * 0.5, radius: 190, hue: 210 },
  ];

  for (const glow of glows) {
    const radial = ctx.createRadialGradient(
      glow.x,
      glow.y,
      0,
      glow.x,
      glow.y,
      glow.radius,
    );
    radial.addColorStop(0, hsla(glow.hue, 88, 64, 0.24));
    radial.addColorStop(1, hsla(glow.hue, 88, 40, 0));
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
}

function drawPanel(ctx) {
  const x = PADDING;
  const y = PADDING;
  const width = WIDTH - PADDING * 2;
  const height = HEIGHT - PADDING * 2;
  const radius = 18;

  ctx.save();
  roundRect(ctx, x, y, width, height, radius);
  ctx.clip();

  const panelGradient = ctx.createLinearGradient(x, y, x, y + height);
  panelGradient.addColorStop(0, "rgba(255,255,255,0.09)");
  panelGradient.addColorStop(1, "rgba(255,255,255,0.025)");
  ctx.fillStyle = panelGradient;
  roundRect(ctx, x, y, width, height, radius);
  ctx.fill();

  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(148,163,184,0.32)";
  ctx.lineWidth = 1.4;
  roundRect(ctx, x + 0.5, y + 0.5, width - 1, height - 1, radius);
  ctx.stroke();
  ctx.restore();
}

function drawInterference(ctx) {
  for (let index = 0; index < 4; index += 1) {
    const baseY = randomInt(48, HEIGHT - 48);
    ctx.beginPath();
    ctx.strokeStyle = hsla(
      randomInt(205, 275),
      72,
      68,
      randomFloat(0.07, 0.14),
    );
    ctx.lineWidth = randomFloat(1, 2.2);
    ctx.moveTo(0, baseY);

    for (let x = 0; x <= WIDTH; x += 36) {
      ctx.lineTo(
        x,
        baseY + Math.sin((x + index * 42) * 0.035) * randomInt(7, 16),
      );
    }

    ctx.stroke();
  }
}

function drawDigit(ctx, char, centerX, centerY) {
  const rotation = randomFloat(-0.11, 0.11);
  const offsetY = randomInt(-3, 3);
  const fontSize = 50;
  const slotWidth = 56;
  const slotHeight = 70;

  ctx.save();
  ctx.translate(centerX, centerY + offsetY);
  ctx.rotate(rotation);

  roundRect(ctx, -slotWidth / 2, -slotHeight / 2 + 4, slotWidth, slotHeight, 11);
  const slotGradient = ctx.createLinearGradient(0, -slotHeight / 2, 0, slotHeight / 2);
  slotGradient.addColorStop(0, "rgba(255,255,255,0.14)");
  slotGradient.addColorStop(1, "rgba(255,255,255,0.04)");
  ctx.fillStyle = slotGradient;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.shadowColor = "rgba(99,102,241,0.42)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;

  const textGradient = ctx.createLinearGradient(0, -fontSize / 2, 0, fontSize / 2);
  textGradient.addColorStop(0, "#f8fafc");
  textGradient.addColorStop(0.45, "#dbeafe");
  textGradient.addColorStop(1, "#818cf8");

  ctx.font = `700 ${fontSize}px "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = textGradient;
  ctx.fillText(char, 0, 0);

  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(15,23,42,0.32)";
  ctx.lineWidth = 1.8;
  ctx.strokeText(char, 0, 0);
  ctx.restore();
}

function drawAccentLine(ctx) {
  const accent = ctx.createLinearGradient(PADDING, 0, WIDTH - PADDING, 0);
  accent.addColorStop(0, "rgba(99,102,241,0)");
  accent.addColorStop(0.5, "rgba(129,140,248,0.7)");
  accent.addColorStop(1, "rgba(99,102,241,0)");
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PADDING + 48, PADDING + 7);
  ctx.lineTo(WIDTH - PADDING - 48, PADDING + 7);
  ctx.stroke();
}

function drawGrain(ctx) {
  for (let index = 0; index < 280; index += 1) {
    ctx.fillStyle = `rgba(255,255,255,${randomFloat(0.012, 0.035)})`;
    ctx.fillRect(randomInt(0, WIDTH), randomInt(0, HEIGHT), 1, 1);
  }
}

function renderCaptchaImage(code) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx);
  drawPanel(ctx);
  drawInterference(ctx);

  const chars = String(code).split("");
  const gap = 84;
  const totalWidth = (chars.length - 1) * gap;
  const startX = WIDTH / 2 - totalWidth / 2;
  const centerY = HEIGHT / 2 + 2;

  chars.forEach((char, index) => {
    drawDigit(ctx, char, startX + index * gap, centerY);
  });

  drawGrain(ctx);
  drawAccentLine(ctx);

  return canvas.toBuffer("image/png");
}

module.exports = {
  generateCaptchaCode,
  generateCaptchaOptions,
  renderCaptchaImage,
};
