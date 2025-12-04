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

import pino from "pino";
import fs from "fs/promises";
import path from "path";

// --- ENV CONFIG ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const BUCKET_NAME = process.env.SUPABASE_BUCKET || "whatsapp-sessions";
const CLIENT_ID = process.env.WHATSAPP_CLIENT_ID || "bot-960lite";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Supabase URL/KEY missing");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ----------------------------
// DOWNLOAD SESSION ON START
// ----------------------------
async function downloadAuthFolder(authFolder) {
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .list(`${CLIENT_ID}_auth/`);

    if (error || !data || data.length === 0) {
      console.log("ℹ️ No previous session found. Fresh login needed.");
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

    console.log("✅ Session loaded (read-only start mode)");
  } catch (err) {
    console.log("⚠ Failed to download session:", err.message);
  }
}

// ----------------------------
// UPLOAD ONLY IF FILE UPDATED
// ----------------------------
async function uploadUpdatedFiles(authFolder) {
  try {
    const files = await fs.readdir(authFolder);

    for (const file of files) {
      const filePath = path.join(authFolder, file);
      const binary = await fs.readFile(filePath);

      await supabase.storage
        .from(BUCKET_NAME)
        .upload(`${CLIENT_ID}_auth/${file}`, binary, {
          cacheControl: "0",
          upsert: true
        });
    }

    console.log("☁ Session updated to Supabase");
  } catch (e) {
    console.log("⚠ Session upload skipped:", e.message);
  }
}

// ----------------------------------------------------
// MAIN BOT
// ----------------------------------------------------
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

  // On session update -> save locally AND upload to Supabase (hybrid)
  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await uploadUpdatedFiles(authFolder);
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 Scan QR to login:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") console.log("✅ WhatsApp connected!");

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) startBot();
      else console.log("❌ Logged out. Scan QR again.");
    }
  });

  // ----------------------------------------------------
  // MESSAGE RECEIVER + HYBRID JID NORMALIZER + RANDOM DELAY
  // ----------------------------------------------------
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) return;

      let jid = msg.key.remoteJid;
      const text = msg.message.conversation ??
                   msg.message.extendedTextMessage?.text ?? "";

      // Convert IDs to standard c.us   (except groups)
      if (!jid.endsWith("@g.us")) {
        jid = jid.replace("@s.whatsapp.net", "@c.us");
        jid = jid.replace(/@lid.*/, "@c.us");
      }

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

          const reply = replyData?.reply || replyData?.Reply;

          if (reply) {
            const delay = 10000 + Math.random() * 10000;
            setTimeout(() => {
              sock.sendMessage(jid, { text: reply });
              console.log("💬 Sent reply:", reply);
            }, delay);
          }
        } catch (e) {
          console.log("Webhook Error:", e.message);
        }
      }
    }
  });
}

startBot();

// Web server (prevent Render timeout)
express().get("/", (r, s) => s.send("Bot Running ✓"))
         .listen(PORT, () => console.log("🌐 PORT", PORT));
