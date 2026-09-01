const { createCanvas } = require("@napi-rs/canvas");

const WIDTH = 780;
const HEIGHT = 248;
const PANEL_X = 28;
const PANEL_Y = 28;
const PANEL_W = WIDTH - PANEL_X * 2;
const PANEL_H = HEIGHT - PANEL_Y * 2;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
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
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawBackground(ctx) {
  const base = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  base.addColorStop(0, "#05070f");
  base.addColorStop(0.45, "#0b1224");
  base.addColorStop(1, "#070b16");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const glows = [
    { x: WIDTH * 0.2, y: HEIGHT * 0.35, r: 170, color: "rgba(88,101,242,0.28)" },
    { x: WIDTH * 0.78, y: HEIGHT * 0.62, r: 150, color: "rgba(56,189,248,0.18)" },
    { x: WIDTH * 0.52, y: HEIGHT * 0.18, r: 120, color: "rgba(167,139,250,0.16)" },
  ];

  for (const glow of glows) {
    const radial = ctx.createRadialGradient(glow.x, glow.y, 0, glow.x, glow.y, glow.r);
    radial.addColorStop(0, glow.color);
    radial.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
}

function drawGrid(ctx) {
  ctx.save();
  ctx.strokeStyle = "rgba(148,163,184,0.06)";
  ctx.lineWidth = 1;

  for (let x = 0; x <= WIDTH; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }

  for (let y = 0; y <= HEIGHT; y += 24) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
    ctx.stroke();
  }

  ctx.restore();
}

function drawPanel(ctx) {
  ctx.save();
  ctx.shadowColor = "rgba(88,101,242,0.35)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  roundRect(ctx, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 22);
  ctx.fillStyle = "rgba(15,23,42,0.72)";
  ctx.fill();
  ctx.restore();

  const border = ctx.createLinearGradient(PANEL_X, PANEL_Y, PANEL_X + PANEL_W, PANEL_Y + PANEL_H);
  border.addColorStop(0, "rgba(129,140,248,0.55)");
  border.addColorStop(0.5, "rgba(56,189,248,0.35)");
  border.addColorStop(1, "rgba(129,140,248,0.55)");
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.6;
  roundRect(ctx, PANEL_X + 0.5, PANEL_Y + 0.5, PANEL_W - 1, PANEL_H - 1, 22);
  ctx.stroke();
}

function drawHeader(ctx) {
  ctx.font = '600 13px "Segoe UI", Arial, sans-serif';
  ctx.fillStyle = "rgba(226,232,240,0.72)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("CODIGO DE VERIFICACAO", WIDTH / 2, PANEL_Y + 24);

  const line = ctx.createLinearGradient(PANEL_X + 80, 0, PANEL_X + PANEL_W - 80, 0);
  line.addColorStop(0, "rgba(99,102,241,0)");
  line.addColorStop(0.5, "rgba(129,140,248,0.75)");
  line.addColorStop(1, "rgba(99,102,241,0)");
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PANEL_X + 92, PANEL_Y + 38);
  ctx.lineTo(PANEL_X + PANEL_W - 92, PANEL_Y + 38);
  ctx.stroke();
}

function drawCornerBrackets(ctx) {
  const inset = PANEL_X + 14;
  const top = PANEL_Y + 14;
  const bottom = PANEL_Y + PANEL_H - 14;
  const left = inset;
  const right = PANEL_X + PANEL_W - 14;
  const size = 16;

  ctx.strokeStyle = "rgba(148,163,184,0.35)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";

  [
    [left, top + size, left, top, left + size, top],
    [right - size, top, right, top, right, top + size],
    [left, bottom - size, left, bottom, left + size, bottom],
    [right - size, bottom, right, bottom, right, bottom - size],
  ].forEach(([x1, y1, x2, y2, x3, y3]) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.stroke();
  });
}

function drawWaveLines(ctx) {
  for (let index = 0; index < 3; index += 1) {
    const baseY = PANEL_Y + 92 + index * 28;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(129,140,248,${0.08 + index * 0.03})`;
    ctx.lineWidth = 1.6;
    ctx.moveTo(PANEL_X + 24, baseY);

    for (let x = PANEL_X + 24; x <= PANEL_X + PANEL_W - 24; x += 18) {
      ctx.lineTo(
        x,
        baseY + Math.sin((x + index * 55) * 0.028) * (10 - index * 2),
      );
    }

    ctx.stroke();
  }
}

function drawDigit(ctx, char, centerX, centerY, highlight = false) {
  const rotation = randomFloat(-0.08, 0.08);
  const fontSize = 54;
  const slotWidth = 62;
  const slotHeight = 78;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);

  roundRect(ctx, -slotWidth / 2, -slotHeight / 2, slotWidth, slotHeight, 14);
  const slotFill = ctx.createLinearGradient(0, -slotHeight / 2, 0, slotHeight / 2);
  slotFill.addColorStop(0, "rgba(255,255,255,0.16)");
  slotFill.addColorStop(1, "rgba(255,255,255,0.05)");
  ctx.fillStyle = slotFill;
  ctx.fill();

  ctx.strokeStyle = highlight ? "rgba(129,140,248,0.85)" : "rgba(255,255,255,0.14)";
  ctx.lineWidth = highlight ? 2 : 1;
  ctx.stroke();

  ctx.shadowColor = highlight ? "rgba(129,140,248,0.55)" : "rgba(15,23,42,0.45)";
  ctx.shadowBlur = highlight ? 18 : 10;
  ctx.shadowOffsetY = 6;

  const textGradient = ctx.createLinearGradient(0, -fontSize / 2, 0, fontSize / 2);
  textGradient.addColorStop(0, "#ffffff");
  textGradient.addColorStop(0.55, "#dbeafe");
  textGradient.addColorStop(1, highlight ? "#a5b4fc" : "#93c5fd");

  ctx.font = `700 ${fontSize}px "Segoe UI", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = textGradient;
  ctx.fillText(char, 0, 1);

  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(15,23,42,0.28)";
  ctx.lineWidth = 1.4;
  ctx.strokeText(char, 0, 1);
  ctx.restore();
}

function drawVignette(ctx) {
  const vignette = ctx.createRadialGradient(
    WIDTH / 2,
    HEIGHT / 2,
    WIDTH * 0.18,
    WIDTH / 2,
    HEIGHT / 2,
    WIDTH * 0.72,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function renderCaptchaImage(code) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const chars = String(code).split("");
  const highlightIndex = randomInt(0, Math.max(0, chars.length - 1));

  drawBackground(ctx);
  drawGrid(ctx);
  drawPanel(ctx);
  drawHeader(ctx);
  drawCornerBrackets(ctx);
  drawWaveLines(ctx);

  const gap = 88;
  const totalWidth = (chars.length - 1) * gap;
  const startX = WIDTH / 2 - totalWidth / 2;
  const centerY = PANEL_Y + PANEL_H / 2 + 18;

  chars.forEach((char, index) => {
    drawDigit(ctx, char, startX + index * gap, centerY, index === highlightIndex);
  });

  drawVignette(ctx);

  return canvas.toBuffer("image/png");
}

module.exports = {
  generateCaptchaCode,
  generateCaptchaOptions,
  renderCaptchaImage,
};
