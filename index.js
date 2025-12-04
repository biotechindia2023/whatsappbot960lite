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

// --- Helper: Download auth folder from Supabase (read-only) ---
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
    console.log("✅ Auth folder downloaded from Supabase (read-only)");
  } catch (err) {
    console.warn("⚠️ Failed to download auth folder:", err.message);
  }
}

// --- Helper: upload only updated files (hybrid small-write) ---
async function uploadUpdatedFiles(authFolder) {
  const metaPath = path.join(authFolder, ".uploaded_meta.json");
  let meta = {};
  try {
    const metaBuf = await fs.readFile(metaPath, "utf8");
    meta = JSON.parse(metaBuf);
  } catch (err) {
    // no meta file yet — start fresh
    meta = {};
  }

  try {
    const files = await fs.readdir(authFolder);
    for (const file of files) {
      if (file === ".uploaded_meta.json") continue; // skip meta
      const fullPath = path.join(authFolder, file);
      try {
        const st = await fs.stat(fullPath);
        const mtime = st.mtimeMs;
        if (!meta[file] || mtime > meta[file]) {
          // file is new or updated — upload
          try {
            const buffer = await fs.readFile(fullPath);
            const { error } = await supabase.storage
              .from(BUCKET_NAME)
              .upload(`${CLIENT_ID}_auth/${file}`, buffer, { contentType: "application/octet-stream", upsert: true });
            if (error) {
              console.warn(`⚠ Session upload skipped (supabase error): ${file} — ${error.message || error}`);
            } else {
              meta[file] = mtime;
              console.log(`☁ Session updated to Supabase: ${file}`);
            }
          } catch (readErr) {
            // file may have disappeared between readdir and readFile
            console.warn(`⚠ Session upload skipped: ${readErr.message}`);
          }
        }
      } catch (statErr) {
        // file not present or inaccessible — skip
        console.warn(`⚠ Session upload skipped: ${statErr.message}`);
      }
    }
    // write meta back (best-effort)
    try {
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
    } catch (metaErr) {
      console.warn("⚠ Failed to write upload meta:", metaErr.message);
    }
  } catch (err) {
    console.warn("⚠ Failed to scan auth folder for uploads:", err.message);
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

  // Hybrid: save locally and upload only changed files
  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (err) {
      console.warn("⚠ Failed to save creds locally:", err?.message || err);
    }
    // upload only updated files (small/write-only)
    try {
      await uploadUpdatedFiles(authFolder);
    } catch (err) {
      console.warn("⚠ uploadUpdatedFiles error:", err?.message || err);
    }
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
  sock.ev.on("messages.upsert", async (msgUpdate) => {
    const { messages, type } = msgUpdate;
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      let jid = msg.key.remoteJid;
      const text = msg.message.conversation
        ?? msg.message.extendedTextMessage?.text
        ?? "";

      if (!text) continue;

      // --- Normalize personal chats to phoneNumber@c.us ---
      if (!jid.endsWith("@g.us")) {
        if (msg.key.senderPn) {
          const phoneNumber = msg.key.senderPn.split("@")[0];
          jid = `${phoneNumber}@c.us`;
        } else if (jid.includes("@s.whatsapp.net")) {
          jid = jid.replace("@s.whatsapp.net", "@c.us");
        } else if (jid.includes("@lid")) {
          jid = jid.replace(/@.*$/, "@c.us");
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
          try {
            replyData = await res.json();
          } catch {}
          if (Array.isArray(replyData)) replyData = replyData[0];
          const reply = replyData?.Reply ?? replyData?.reply;
          if (reply) {
            // --- Add random delay between 10-20 seconds ---
            const delay = Math.floor(Math.random() * (20000 - 10000 + 1)) + 10000;
            setTimeout(async () => {
              await sock.sendMessage(jid, { text: reply });
              console.log("💬 Reply sent (delayed):", reply);
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
app.get("/", (_req, res) => res.send("✅ Bot is running"));
app.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));
