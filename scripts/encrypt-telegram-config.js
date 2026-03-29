const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.join(__dirname, "..");
const AUTH_CONFIG_PATH = path.join(ROOT_DIR, "config", "createpost-auth.json");
const TELEGRAM_CONFIG_PATH = path.join(ROOT_DIR, "config", "telegram.secure.json");

function deriveKey(authConfig) {
  const seed = `${authConfig.salt}:${authConfig.hash}:${authConfig.iterations}`;
  return crypto.createHash("sha256").update(seed).digest();
}

function main() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || "").trim();

  if (!token || !chatId) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env var");
    process.exit(1);
  }

  const authConfig = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, "utf8"));
  const key = deriveKey(authConfig);
  const iv = crypto.randomBytes(12);

  const payload = JSON.stringify({ token, chatId, botUsername });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const output = {
    algorithm: "aes-256-gcm",
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };

  fs.writeFileSync(TELEGRAM_CONFIG_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Encrypted Telegram config saved to ${TELEGRAM_CONFIG_PATH}`);
}

main();

