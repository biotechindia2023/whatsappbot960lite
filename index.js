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

import pino from "pino"; // silent
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

// ---------------- Download session (read-only start) ----------------
async function downloadAuthFolder(authFolder) {
  try {
    const { data } = await supabase.storage.from(BUCKET_NAME).list(`${CLIENT_ID}_auth/`);
    if (!data || data.length === 0) return console.log("ℹ️ No auth session found – new login");

    await fs.mkdir(authFolder, { recursive: true });

    for (const f of data) {
      const { data: file } = await supabase.storage
        .from(BUCKET_NAME)
        .download(`${CLIENT_ID}_auth/${f.name}`);

      if (!file) continue;
      const buf = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(path.join(authFolder, f.name), buf);
    }
    console.log("✅ Session loaded (read-only start mode)");
  } catch (err) {
    console.log("⚠️ Could not load session:", err.message);
  }
}

// ---------------- Upload only when updates happen (Hybrid Mode) ----------------
async function uploadUpdatedFiles(folderPath, changedFiles) {
  for (const file of changedFiles) {
    const filePath = path.join(folderPath, file);
    const data = await fs.readFile(filePath);

    await supabase.storage.from(BUCKET_NAME)
      .upload(`${CLIENT_ID}_auth/${file}`, data, { upsert: true });

    console.log("⬆ Session updated:", file);
  }
}

// ---------------- Start Bot ----------------
async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const authFolder = path.resolve(`./${CLIENT_ID}_auth`);
  await downloadAuthFolder(authFolder);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    version,
    auth: state,
  });

  // 🔥 Trigger only when WhatsApp updates keys
  sock.ev.on("creds.update", async () => {
    await saveCreds();                                 // write locally minimal
    const files = Object.keys(state.creds || {});
    uploadUpdatedFiles(authFolder, files);             // hybrid upload only changed
  });

  // ---------------- Connection handler ----------------
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === "open") console.log("✅ WhatsApp connected!");

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("⚠ Disconnected:", code);
      if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 4000);
      else console.log("❌ Logged out. Scan QR again.");
    }
  });

  // ---------------- Handle messages ----------------
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      let jid = msg.key.remoteJid;
      const text = msg.message.conversation ??
                   msg.message.extendedTextMessage?.text ?? "";

      if (!text) continue;

      // ---- Convert to phone@c.us except group ----
      if (!jid.endsWith("@g.us")) {
        const pn = msg.key.senderPn?.split("@")[0];
        jid = pn ? `${pn}@c.us`
                 : jid.replace(/@s.whatsapp.net|@lid.*/g, "@c.us");
      }

      console.log("📩", jid, ":", text);

      // ---- Webhook handling ----
      if (N8N_WEBHOOK_URL) {
        try {
          const res = await fetch(N8N_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: jid, message: text })
          });

          let data = {};
          try { data = await res.json(); } catch {};
          if (Array.isArray(data)) data = data[0];

          const reply = data?.Reply || data?.reply;
          if (reply) {
            const delay = Math.floor(Math.random() * 11000) + 9000; // ~10–20 sec
            setTimeout(() => sock.sendMessage(jid, { text: reply }), delay);
            console.log("⏳ Reply queued:", delay/1000,"sec");
          }
        } catch (e) { console.log("Webhook error:", e.message); }
      }
    }
  });
}

startBot();

// ---------------- Health page ----------------
express().get("/", (r, s) => s.send("Bot Active ✓"))
.listen(PORT, () => console.log("🌐 PORT", PORT));
