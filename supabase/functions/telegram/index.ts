// Edge Function "telegram" (E) — Telegram webhook.
// Telegram calls it with header X-Telegram-Bot-Api-Secret-Token (Vault: telegram_webhook_secret).
// Replies only to chat 1893239479. Commands: /status (also /start, /help).
// Internal calls (x-poll-secret, e.g. from SQL): {"setup":true} → setWebhook · {"info":true} → getWebhookInfo · {"preview":true} → /status text ·
//                                               a Telegram-shaped update {"message":{…}} → handled as if from Telegram (testing)
import { buildStatus, internalAuth, json, sb, telegram } from "../_shared/common.ts";

const ALLOWED_CHAT = 1893239479;
const HELP = "คำสั่งที่ใช้ได้:\n/status — ยอดทุกตลาดที่ active, เวลาที่เหลือ, สถานะระบบ, เงียบมากี่ชั่วโมง";

async function tgApi(method: string, payload: Record<string, unknown>) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  return await r.json();
}

Deno.serve(async (req) => {
  const internal = await internalAuth(req);
  let fromTelegram = false;
  if (!internal) {
    const { data } = await sb.rpc("telegram_auth", { p: req.headers.get("x-telegram-bot-api-secret-token") ?? "" });
    fromTelegram = data === true;
  }
  if (!internal && !fromTelegram) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));

  try {
    if (internal && body?.setup) {
      const { data: secret, error } = await sb.rpc("telegram_webhook_secret");
      if (error || !secret) throw new Error("telegram_webhook_secret missing");
      const r = await tgApi("setWebhook", {
        url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram`,
        secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true,
      });
      return json({ ok: r.ok, description: r.description });
    }
    if (internal && body?.preview) return json({ ok: true, text: await buildStatus(Date.now()) });  // /status text, not sent
    if (internal && body?.info) {
      const r = await tgApi("getWebhookInfo", {});
      const i = r.result ?? {};
      return json({ ok: r.ok, url: i.url, pending: i.pending_update_count, last_error: i.last_error_message, last_error_date: i.last_error_date });
    }

    const msg = body?.message ?? body?.edited_message;
    const chatId = msg?.chat?.id;
    if (!msg || chatId !== ALLOWED_CHAT) return json({ ok: true, ignored: true });  // other chats: silent
    const text = String(msg.text ?? "").trim();
    if (/^\/status(@\w+)?\b/i.test(text)) await telegram(await buildStatus(Date.now()), chatId);
    else if (/^\/(start|help)(@\w+)?\b/i.test(text)) await telegram(HELP, chatId);
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ ok: true, error: String(e) });  // 200 so Telegram does not retry forever
  }
});
