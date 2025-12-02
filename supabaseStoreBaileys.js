import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";

export class SupabaseStoreBaileys {
    constructor(supabaseUrl, supabaseKey, bucket = "whatsapp-sessions", clientId = "render-bot-960") {
        this.supabase = createClient(supabaseUrl, supabaseKey);
        this.bucket = bucket;
        this.clientId = clientId;
    }

    // Load session from bucket
    async load() {
        try {
            const { data, error } = await this.supabase.storage
                .from(this.bucket)
                .download(`${this.clientId}.json`);

            if (error || !data) {
                console.log("⚠️ No session found in Supabase bucket");
                return null;
            }

            const json = JSON.parse(Buffer.from(await data.arrayBuffer()).toString());
            console.log("✅ Session loaded from Supabase bucket");
            return json;
        } catch (err) {
            console.error("❌ Failed to load session from Supabase:", err.message);
            return null;
        }
    }

    // Save session to bucket
    async save(sessionData) {
        try {
            const buffer = Buffer.from(JSON.stringify(sessionData, null, 2));
            const { error } = await this.supabase.storage
                .from(this.bucket)
                .upload(`${this.clientId}.json`, buffer, { contentType: "application/json", upsert: true });

            if (error) throw error;

            console.log("💾 Session saved to Supabase bucket");
        } catch (err) {
            console.error("❌ Failed to save session to Supabase:", err.message);
        }
    }

    // Delete session from bucket
    async delete() {
        try {
            const { error } = await this.supabase.storage
                .from(this.bucket)
                .remove([`${this.clientId}.json`]);

            if (error) throw error;
            console.log("🗑️ Session deleted from Supabase bucket");
        } catch (err) {
            console.error("❌ Failed to delete session from Supabase:", err.message);
        }
    }
}
