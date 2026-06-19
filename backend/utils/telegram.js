'use strict';

// Shared Telegram helper — used by roster reminders, swap notifications, etc.
// Never throws — a failed notification should never crash a request.
async function notifyTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, reason: 'not configured' };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       message,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[Telegram] notify failed:', data.description);
      return { ok: false, reason: data.description };
    }
    return { ok: true, message_id: data.result?.message_id };
  } catch (err) {
    console.warn('[Telegram] notify error:', err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = { notifyTelegram };
