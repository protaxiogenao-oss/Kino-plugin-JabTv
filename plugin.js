/// <reference path="./kino.d.ts" />
/**
 * Jable.TV — Kino plugin v1.0.0
 * Author: Hotaru Yume / hotaruyume
 * Fuente: jable.tv
 * - Listados vía páginas + modo async (list_videos_common_videos_list / search)
 * - Resolve: extrae var hlsUrl = '...' (m3u8) del HTML de la ficha; HLS prioritario
 * - Home: Recientes, Uncensored, Chinese Subtitle, Hot, New Release + Ver más máximo
 * - Posters: data-src de img-box; evita anuncios / CF challenge
 * - Funciona en teléfono y TV (HLS con headers Referer)
 */

const BASE = "https://jable.tv";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MAX_PAGE = 48;
const HOME_ROW = 12;

const AD_RE =
  /\b(sponsored|sponsor|advert|promo code|trafficjunky|exoclick|juicyads|outbrain|taboola|click here|buy now|discount|affiliate|直播|廣告|广告)\b/i;

/** Secciones Home (path relativo a BASE) */
const SECTIONS = [
  { id: "latest", title: "Recientes", path: "/latest-updates/" },
  { id: "uncensored", title: "Uncensored", path: "/categories/uncensored/" },
  { id: "chinese-sub", title: "Chinese Subtitle", path: "/categories/chinese-subtitle/" },
  { id: "hot", title: "Más vistos", path: "/hot/" },
  { id: "new-release", title: "Nuevos estrenos", path: "/new-release/" },
];

function log() {
  try {
    if (typeof kino !== "undefined" && kino.log) {
      kino.log.apply(kino, arguments);
    }
  } catch (e) {}
}

function hdr(extra) {
  var h = {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,es;q=0.6",
    Referer: BASE + "/",
    Cookie: "language=en_US; age_verified=1",
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

function strip(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absUrl(u) {
  if (!u) return "";
  u = String(u).replace(/&amp;/g, "&").trim();
  if (!u || u.indexOf("data:") === 0) return "";
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.indexOf("http") === 0) return u;
  if (u.charAt(0) === "/") return BASE + u;
  return BASE + "/" + u;
}

function isAd(title) {
  return AD_RE.test(title || "");
}

function isChallenge(html) {
  if (!html) return true;
  var t = String(html).slice(0, 800);
  return (
    t.indexOf("Just a moment") !== -1 ||
    t.indexOf("cf-mitigated") !== -1 ||
    t.indexOf("challenge-platform") !== -1 ||
    t.indexOf("Enable JavaScript and cookies") !== -1
  );
}

async function fetchHtml(url, extraHeaders) {
  var r = await kino.fetch(url, {
    headers: hdr(extraHeaders),
    maxBytes: 2 * 1024 * 1024,
  });
  if (r.status === 429) throw kino.error("rate_limited", "demasiadas peticiones");
  if (r.status === 404) throw kino.error("not_found");
  if (!r.ok) throw kino.error("unavailable", "el sitio respondió " + r.status);
  var text = r.body || r.text || "";
  if (typeof text !== "string") text = String(text);
  if (isChallenge(text)) {
    throw kino.error(
      "unavailable",
      "Cloudflare bloqueó la petición. Reintenta más tarde o usa VPN."
    );
  }
  return text;
}

/**
 * Parsea tarjetas de listado:
 * <div class="img-box cover-md"> ... data-src="..." ... <a href="/videos/xxx/">title</a>
 * También soporta bloques async del list_videos_* .
 */
function parseCards(html, limit) {
  var items = [];
  if (!html) return items;
  limit = limit || MAX_PAGE;

  // Preferir bloques de vídeo conocidos
  var blocks = [];
  var reBlock =
    /<div[^>]*class="[^"]*(?:video-img-box|img-box|col-6|col-sm-4|col-lg-3)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>)?/gi;
  var m;
  while ((m = reBlock.exec(html)) !== null) {
    blocks.push(m[0]);
  }
  if (blocks.length === 0) {
    // Fallback: buscar enlaces a /videos/
    var reLink =
      /<a[^>]+href="((?:https?:\/\/[^"]*)?\/videos\/([a-zA-Z0-9_-]+)\/?)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = reLink.exec(html)) !== null && items.length < limit) {
      var href = absUrl(m[1]);
      var slug = m[2];
      var title = strip(m[3]);
      if (!slug || !title || isAd(title)) continue;
      var poster = "";
      var near = html.slice(Math.max(0, m.index - 400), m.index + 200);
      var pm =
        near.match(/data-src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) ||
        near.match(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
      if (pm) poster = absUrl(pm[1]);
      items.push({
        id: "jable-" + slug,
        ref: "video:" + slug,
        title: title,
        kind: "movie",
        poster: poster || undefined,
        adult: true,
      });
    }
    return items.slice(0, limit);
  }

  for (var i = 0; i < blocks.length && items.length < limit; i++) {
    var b = blocks[i];
    var hrefM =
      b.match(/href="((?:https?:\/\/[^"]*)?\/videos\/([a-zA-Z0-9_-]+)\/?)"/i) ||
      b.match(/href="(\/videos\/([a-zA-Z0-9_-]+)\/?)"/i);
    if (!hrefM) continue;
    var slug = hrefM[2];
    var titleM =
      b.match(/class="title"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i) ||
      b.match(/<a[^>]+href="[^"]*\/videos\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      b.match(/title="([^"]+)"/i);
    var title = titleM ? strip(titleM[1]) : slug;
    if (!title || isAd(title)) continue;

    var poster = "";
    var pm =
      b.match(/data-src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) ||
      b.match(/data-src="(\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) ||
      b.match(/src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    if (pm) poster = absUrl(pm[1]);

    items.push({
      id: "jable-" + slug,
      ref: "video:" + slug,
      title: title,
      kind: "movie",
      poster: poster || undefined,
      adult: true,
    });
  }
  return items;
}

function pageUrl(path, page) {
  page = page || 1;
  var p = path;
  if (p.charAt(0) !== "/") p = "/" + p;
  if (page <= 1) return BASE + p;
  // jable usa /path/2/ o ?from=
  if (p.indexOf("?") >= 0) return BASE + p + "&from=" + page;
  return BASE + p.replace(/\/?$/, "/") + page + "/";
}

function asyncListUrl(path, page) {
  page = page || 1;
  var basePath = path.replace(/\/?$/, "/");
  return (
    BASE +
    basePath +
    "?mode=async&function=get_block&block_id=list_videos_common_videos_list&sort_by=post_date&from=" +
    page +
    "&_=" +
    Date.now()
  );
}

function asyncSearchUrl(q, page) {
  page = page || 1;
  var enc = encodeURIComponent(q);
  return (
    BASE +
    "/search/" +
    enc +
    "/?mode=async&function=get_block&block_id=list_videos_videos_list_search_result&q=" +
    enc +
    "&sort_by=&from=" +
    page +
    "&_=" +
    Date.now()
  );
}

async function loadList(path, page, limit) {
  limit = limit || MAX_PAGE;
  var urls = [asyncListUrl(path, page), pageUrl(path, page)];
  var lastErr = null;
  for (var i = 0; i < urls.length; i++) {
    try {
      var html = await fetchHtml(urls[i]);
      var items = parseCards(html, limit);
      if (items.length > 0) return items;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

export async function search(query) {
  var q = (query && query.q) || "";
  q = String(q).trim();
  if (!q) return { items: [] };

  var cursor = query.cursor || null;
  var page = 1;
  if (cursor) {
    var n = parseInt(String(cursor).replace(/\D/g, ""), 10);
    if (n > 0) page = n;
  }

  var url = asyncSearchUrl(q, page);
  var html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    // fallback página normal
    html = await fetchHtml(BASE + "/search/" + encodeURIComponent(q) + "/");
  }
  var items = parseCards(html, MAX_PAGE);
  var next = items.length >= 12 ? String(page + 1) : undefined;
  return { items: items, next: next };
}

export async function home() {
  var rows = [];
  for (var i = 0; i < SECTIONS.length; i++) {
    var sec = SECTIONS[i];
    try {
      var items = await loadList(sec.path, 1, HOME_ROW);
      if (items.length === 0) continue;
      rows.push({
        id: sec.id,
        title: sec.title,
        items: items,
        ref: "browse:" + sec.id,
      });
    } catch (e) {
      log("home section fail", sec.id, String(e && e.message ? e.message : e));
    }
  }
  return rows;
}

export async function browse(ref, cursor) {
  var id = String(ref || "").replace(/^browse:/, "");
  var sec = null;
  for (var i = 0; i < SECTIONS.length; i++) {
    if (SECTIONS[i].id === id) {
      sec = SECTIONS[i];
      break;
    }
  }
  if (!sec) throw kino.error("not_found", "sección desconocida");

  var page = 1;
  if (cursor) {
    var n = parseInt(String(cursor).replace(/\D/g, ""), 10);
    if (n > 0) page = n;
  }

  var items = await loadList(sec.path, page, MAX_PAGE);
  var next = items.length >= 12 ? String(page + 1) : undefined;
  return { items: items, next: next };
}

export async function resolve(ref) {
  var slug = String(ref || "").replace(/^video:/, "").replace(/\/+$/, "");
  if (!slug || slug.indexOf(":") >= 0) {
    throw kino.error("not_found", "ref inválido");
  }

  var pageUrlFull = BASE + "/videos/" + slug + "/";
  var html = await fetchHtml(pageUrlFull);

  // Prioridad: var hlsUrl = 'https://....m3u8'
  var m3u8 = null;
  var m =
    html.match(/var\s+hlsUrl\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i) ||
    html.match(/hlsUrl\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i) ||
    html.match(/(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/i);
  if (m) m3u8 = m[1].replace(/\\u0026/g, "&").replace(/&amp;/g, "&");

  if (!m3u8) {
    // source tags / video src
    m =
      html.match(/<source[^>]+src=["']([^"']+\.m3u8[^"']*)["']/i) ||
      html.match(/<video[^>]+src=["']([^"']+\.m3u8[^"']*)["']/i);
    if (m) m3u8 = m[1];
  }

  if (!m3u8) {
    throw kino.error(
      "unavailable",
      "No se encontró stream HLS en la página (posible anuncio o bloqueo)."
    );
  }

  // Evitar URLs de anuncios obvias
  if (
    /ads?\.|advert|promo|preroll|banner|click|track/i.test(m3u8) &&
    !/\.m3u8/i.test(m3u8)
  ) {
    throw kino.error("unavailable", "URL de anuncio descartada");
  }

  var headers = {
    "User-Agent": UA,
    Referer: pageUrlFull,
    Origin: BASE,
  };

  // Extraer título / poster opcionales para media
  var title = "";
  var tm =
    html.match(/property="og:title"\s+content="([^"]+)"/i) ||
    html.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
  if (tm) title = strip(tm[1]).replace(/\s*-\s*Jable\.?TV.*$/i, "");

  return {
    url: m3u8,
    mime: "application/x-mpegURL",
    headers: headers,
    label: "HLS",
    media: title ? { title: title } : undefined,
  };
}
