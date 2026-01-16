// --- LOAD ENV FIRST ---
import "dotenv/config";
import express from "express";
import qrcode from "qrcode-terminal";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import pino from "pino";   // <-- SILENT MODE ENABLED
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

// --- Helper: Download auth folder from Supabase ---
async function downloadAuthFolder(authFolder) {
  try {
    const { data, error } = await supabase.storage.from(BUCKET_NAME).list(`${CLIENT_ID}_auth/`);
    if (error || !data || data.length === 0) {
      console.log("ℹ️ No auth files in Supabase, starting fresh");
      return;
    }
    await fs.mkdir(authFolder, { recursive: true });
    for (const file of data) {
      const { data: fileData, error: downloadErr } = await supabase.storage
        .from(BUCKET_NAME)
        .download(`${CLIENT_ID}_auth/${file.name}`);
      if (downloadErr || !fileData) continue;
      const buf = Buffer.from(await fileData.arrayBuffer());
      await fs.writeFile(path.join(authFolder, file.name), buf);
    }
    console.log("✅ Auth folder downloaded from Supabase (read/write)");
  } catch (err) {
    console.warn("⚠️ Failed to download auth folder:", err.message);
  }
}

// --- Helper: Upload auth folder to Supabase ---
async function uploadAuthFolder(authFolder) {
  try {
    const files = await fs.readdir(authFolder);
    for (const file of files) {
      const filePath = path.join(authFolder, file);
      const stream = createReadStream(filePath);
      await supabase.storage
        .from(BUCKET_NAME)
        .upload(`${CLIENT_ID}_auth/${file}`, stream, { upsert: true });
    }
    console.log("☁ Auth folder uploaded to Supabase (read/write)");
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
  global.saveCreds = saveCreds;

  // Upload session whenever credentials change
  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await uploadAuthFolder(authFolder);
  });

  // Connection & QR / reconnect handling
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("📲 QR RECEIVED - scan with WhatsApp:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("✅ WhatsApp connected!");
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.warn("⚠️ Disconnected, status code:", statusCode);
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("Reconnecting...");
        setTimeout(startBot, 5000);
      } else {
        console.log("❌ Logged out — scan QR again");
      }
    }
  });

  // Handling incoming messages
  if (msg.key.remoteJid === "status@broadcast") return;
  sock.ev.on("messages.upsert", async (msgUpdate) => {
    const { messages, type } = msgUpdate;
    if (type !== "notify") return;

    for (const msg of messages) {
      // --- DEDUPLICATION CHECK ---
      const msgId = msg.key.id;
      if (processedMessages.has(msgId)) continue;

      if (!msg.message || msg.key.fromMe) continue;

      // Mark as processed
      processedMessages.add(msgId);
      if (processedMessages.size > CACHE_LIMIT) {
        const firstItem = processedMessages.values().next().value;
        processedMessages.delete(firstItem);
      }

      let jid = msg.key.remoteJid;
      const text = msg.message.conversation
        ?? msg.message.extendedTextMessage?.text
        ?? "";

      if (!text) continue;

   // --- Normalize personal chats to phoneNumber@c.us ---
if (!jid.endsWith("@g.us")) {
    // 1. Try to get the actual Phone Number from senderPn if available
    if (msg.key.senderPn) {
        jid = msg.key.senderPn.split("@")[0] + "@c.us";
    } 
    // 2. If it's a standard user JID, ensure it ends with @c.us
    else if (jid.includes("@s.whatsapp.net")) {
        jid = jid.split("@")[0] + "@c.us";
    } 
    // 3. Handle LID (Internal IDs) - Strip everything after @ and force @c.us
    else if (jid.includes("@lid")) {
        jid = jid.split("@")[0] + "@c.us";
    }
}

      console.log(`📩 Message from ${jid}: ${text}`);

      if (N8N_WEBHOOK_URL) {
        try {
          const res = await fetch(N8N_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: jid, message: text }),
          });
          let replyData = {};
          try { replyData = await res.json(); } catch {}
          if (Array.isArray(replyData)) replyData = replyData[0];
          const reply = replyData?.Reply ?? replyData?.reply;

          if (reply) {
            const delay = Math.floor(Math.random() * (20000 - 10000 + 1)) + 10000;
            setTimeout(async () => {
              await sock.sendMessage(jid, { text: reply });
              console.log("💬 Reply sent:", reply);
            }, delay);
          }
        } catch (err) {
          console.error("❌ Error calling webhook:", err.message);
        }
      }
    }
  });
}

// --- Start the bot ---
startBot();

// --- Simple web server for health check ---
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.send("✅ Bot is running"));
app.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));

// --- API endpoint to send message externally ---
app.post("/send", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: "to & message required" });

    const jid = to.includes("@") ? to : `${to}@c.us`;

    await global.sock.sendMessage(jid, { text: message });

    res.json({ success: true, sent_to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

