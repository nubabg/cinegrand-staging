/**
 * Cloudflare Worker — прокси за Arena "next-clean" таблото.
 *
 * ЗАЩО: браузърът на cginspection.org НЕ може да чете директно от
 * arenacrp.com (различен домейн — CORS). Този Worker чете публичното табло
 * СЪРВЪР-СТРАНА и го връща с CORS хедъри, за да може приложението да го ползва.
 *
 * СИГУРНОСТ: Worker-ът е ЗАКЛЮЧЕН само за конкретния публичен next-clean URL —
 * НЕ е отворено прокси и НЕ съдържа никакви пароли/ключове. Ползва само
 * публична страница.
 *
 * ── DEPLOY (еднократно, ~10 мин, безплатно) ──
 * 1. Отиди на https://dash.cloudflare.com  →  регистрирай се / влез
 * 2. Ляво меню: Workers & Pages  →  Create  →  Create Worker
 * 3. Дай име (напр. cinegrand-nextclean)  →  Deploy
 * 4. Натисни "Edit code"  →  изтрий примерния код  →  постави ТОЗИ файл  →  Deploy
 * 5. Копирай URL-а на Worker-а (напр. https://cinegrand-nextclean.<акаунт>.workers.dev)
 * 6. Сложи го в index.html като стойност на NEXTCLEAN_PROXY_URL
 *
 * По желание: за друго кино смени CINEMA_CODE по-долу.
 */

const CINEMA_CODE = "BGSOFCG1"; // Park Center Sofia
const TARGET_URL =
  "https://cinegrand.arenacrp.com/front/default/next-clean?cinemaCode=" +
  CINEMA_CODE + "&language=en-US";

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "no-store",
    };

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    try {
      const upstream = await fetch(TARGET_URL, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://cinegrand.arenacrp.com/",
        },
        // Кеширане от страна на Cloudflare за 20 сек, за да не удряме често киното
        cf: { cacheTtl: 20, cacheEverything: true },
      });

      const html = await upstream.text();
      return new Response(html, {
        status: upstream.status,
        headers: {
          ...cors,
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    } catch (err) {
      return new Response("proxy error: " + (err && err.message ? err.message : err), {
        status: 502,
        headers: cors,
      });
    }
  },
};
