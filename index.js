// --- LOAD ENV FIRST ---
import "dotenv/config";
import express from "express";
import qrcode from "qrcode-terminal";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser
} from "@whiskeysockets/baileys";

import pino from "pino";
import fs from "fs/promises";
import path from "path";
import { createReadStream } from "fs";

// --- DEDUPLICATION CACHE ---
const processedMessages = new Set();
const CACHE_LIMIT = 500;

// --- ENV CONFIG ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const BUCKET_NAME = process.env.SUPABASE_BUCKET || "whatsapp-sessions";
const CLIENT_ID = process.env.WHATSAPP_CLIENT_ID || "bot-960lite";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";
const PORT = process.env.PORT || 3000;

// --- sanity checks ---
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Supabase URL/KEY missing");
  process.exit(1);
}

// --- Supabase client ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * 🔐 Resolve correct sender JID (production-safe)
 * Priority:
 * 1. senderPn
 * 2. participant
 * 3. remoteJid
 */
function resolveIncomingJid(msg) {
  // Groups: keep original g.us
  if (msg.key.remoteJid?.endsWith("@g.us")) {
    return msg.key.remoteJid;
  }

  const senderPn =
    msg.key?.senderPn ||
    msg.senderPn ||
    undefined;

  let rawJid =
    senderPn ||
    msg.participant ||
    msg.key.participant ||
    msg.key.remoteJid;

  if (!rawJid) {
    console.warn("⚠️ Unable to resolve sender JID, using remoteJid");
    rawJid = msg.key.remoteJid;
  }

  // Strip @lid if present
  if (rawJid.includes("@lid")) {
    console.warn(`⚠️ @lid detected, stripping: ${rawJid}`);
    rawJid = rawJid.split("@")[0] + "@s.whatsapp.net";
  }

  // Normalize via Baileys
  let normalized = jidNormalizedUser(rawJid);

  // Brazil mobile fix (55 + XX + 9 + 8 digits)
  const numberOnly = normalized.replace(/\D/g, "");
  if (
    numberOnly.startsWith("55") &&
    numberOnly.length === 12 &&
    numberOnly[4] !== "9"
  ) {
    const fixed =
      numberOnly.slice(0, 4) + "9" + numberOnly.slice(4);
    console.warn(`⚠️ Fixed BR number: ${numberOnly} → ${fixed}`);
    normalized = fixed + "@s.whatsapp.net";
  }

  // Your system uses @c.us → convert AFTER normalization
  return normalized.replace("@s.whatsapp.net", "@c.us");
}

// --- Helper: Download auth folder from Supabase ---
async function downloadAuthFolder(authFolder) {
  try {
    const { data } = await supabase.storage
      .from(BUCKET_NAME)
      .list(`${CLIENT_ID}_auth/`);

    if (!data || data.length === 0) {
      console.log("ℹ️ No auth files in Supabase, starting fresh");
      return;
    }

    await fs.mkdir(authFolder, { recursive: true });

    for (const file of data) {
      const { data: fileData } = await supabase.storage
        .from(BUCKET_NAME)
        .download(`${CLIENT_ID}_auth/${file.name}`);

      if (!fileData) continue;

      const buf = Buffer.from(await fileData.arrayBuffer());
      await fs.writeFile(path.join(authFolder, file.name), buf);
    }

    console.log("✅ Auth folder downloaded from Supabase");
  } catch (err) {
    console.warn("⚠️ Failed to download auth folder:", err.message);
  }
}

// --- Helper: Upload auth folder to Supabase ---
async function uploadAuthFolder(authFolder) {
  try {
    const files = await fs.readdir(authFolder);
    for (const file of files) {
      const stream = createReadStream(path.join(authFolder, file));
      await supabase.storage
        .from(BUCKET_NAME)
        .upload(`${CLIENT_ID}_auth/${file}`, stream, { upsert: true });
    }
    console.log("☁ Auth folder uploaded to Supabase");
  } catch (err) {
    console.warn("⚠️ Failed to upload auth folder:", err.message);
  }
}

// --- Main bot start function ---
async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const authFolder = path.resolve(`./${CLIENT_ID}_auth`);

  await downloadAuthFolder(authFolder);
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    version,
    auth: state
  });

  global.sock = sock;

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await uploadAuthFolder(authFolder);
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 QR RECEIVED:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected!");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.warn("⚠️ Disconnected:", code);

      if (code === DisconnectReason.loggedOut) {
        console.log("❌ Logged out — restart required");
        return;
      }

      console.log("🔁 Reconnecting in 5s...");
      setTimeout(startBot, 5000);
    }
  });

  // --- Incoming messages ---
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key?.remoteJid === "status@broadcast") continue;
      if (!msg.message || msg.key.fromMe) continue;

      const msgId = msg.key.id;
      if (processedMessages.has(msgId)) continue;

      processedMessages.add(msgId);
      if (processedMessages.size > CACHE_LIMIT) {
        processedMessages.delete(processedMessages.values().next().value);
      }

      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        "";

      if (!text) continue;

      const jid = resolveIncomingJid(msg);

      console.log(`📩 Message from ${jid}: ${text}`);

      if (N8N_WEBHOOK_URL) {
        try {
          const res = await fetch(N8N_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: jid, message: text })
          });

          let replyData = {};
          try { replyData = await res.json(); } catch {}

          const reply = replyData?.Reply ?? replyData?.reply;

          if (reply) {
            const delay = Math.floor(Math.random() * 10000) + 10000;
            setTimeout(async () => {
              await sock.sendMessage(jid, { text: reply });
              console.log("💬 Reply sent:", reply);
            }, delay);
          }
        } catch (err) {
          console.error("❌ Webhook error:", err.message);
        }
      }
    }
  });
}

// --- Start ---
startBot();

// --- Health server ---
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("✅ Bot is running"));
app.listen(PORT, () =>
  console.log(`🌐 HTTP server listening on ${PORT}`)
);

// --- External send API ---
app.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: "to & message required" });
    }

    const normalized = jidNormalizedUser(
      to.includes("@") ? to : `${to}@s.whatsapp.net`
    ).replace("@s.whatsapp.net", "@c.us");

    await global.sock.sendMessage(normalized, { text: message });

    res.json({ success: true, sent_to: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
