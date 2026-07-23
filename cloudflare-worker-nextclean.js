/**
 * Cloudflare Worker v2 — прокси за публичните Arena табла на Cine Grand.
 *
 * Поддържа ДВА борда (и само тях — не е отворено прокси, без пароли/ключове):
 *   (по подразбиране)  next-clean  → кога свършва всяка прожекция
 *   ?board=next        next        → следващи прожекции: формат 2D/3D,
 *                                    свободни места, продължителност
 *
 * ── ОБНОВЯВАНЕ НА ВЕЧЕ СЪЗДАДЕН WORKER ──
 * 1. dash.cloudflare.com → Workers & Pages → cinegrand-nextclean
 * 2. Edit code → изтрий стария код → постави ЦЕЛИЯ този файл → Deploy
 * Готово — URL-ът остава същият.
 *
 * ── ПЪРВОНАЧАЛЕН DEPLOY ──
 * Workers & Pages → Create → Create Worker → име: cinegrand-nextclean →
 * Deploy → Edit code → постави този файл → Deploy → копирай URL-а в
 * index.html (NEXTCLEAN_PROXY_URL).
 */

const CINEMA_CODE = "BGSOFCG1"; // Park Center Sofia

const BOARDS = {
  clean:
    "https://cinegrand.arenacrp.com/front/default/next-clean?cinemaCode=" +
    CINEMA_CODE + "&language=en-US",
  next:
    "https://cinegrand.arenacrp.com/front/default/next?cinemaCode=" +
    CINEMA_CODE + "&language=en-US&limit=10",
};

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "X-CG-Worker, X-CG-Board",
      "Cache-Control": "no-store",
      "X-CG-Worker": "v2",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    // Избор на борд — САМО от белия списък
    const reqUrl = new URL(request.url);
    const board = reqUrl.searchParams.get("board") === "next" ? "next" : "clean";
    const target = BOARDS[board];

    try {
      const upstream = await fetch(target, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://cinegrand.arenacrp.com/",
        },
        // Кеширане от страна на Cloudflare за 20 сек — да не удряме често киното
        cf: { cacheTtl: 20, cacheEverything: true },
      });

      const html = await upstream.text();
      return new Response(html, {
        status: upstream.status,
        headers: {
          ...cors,
          "X-CG-Board": board,
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
