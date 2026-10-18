/* Blog del sitio (ricardosanjur.com/blog).
 *
 * Antes cada artículo era un archivo `.md` en el repo: publicar dependía de mí
 * (o de Ricky). Ahora el papá escribe y publica desde el mismo /admin donde ya
 * sube los planos, sin tocar código.
 *
 * Cómo funciona:
 *   - Los artículos viven en D1 (tabla `blog_posts`), en español y en inglés.
 *   - El sitio los LEE de D1 en /blog/<slug> y /en/blog/<slug> (el worker manda
 *     sobre /blog, ver run_worker_first). Los archivos .md siguen sirviendo para
 *     lo que ya estaba publicado.
 *   - El texto se escribe en Markdown simple (# título, **negrita**, - listas).
 *     Se guarda como se envía y se renderiza del lado del worker.
 *
 * Reglas:
 *   - Borrar un artículo lo marca como borrado (no se destruye): si se equivocó,
 *     se puede recuperar desde la base.
 *   - El slug se genera del título si no lo escribe; nunca cambia una vez creado
 *     (cambiarlo rompe el link que ya se compartió).
 */

type BlogRow = {
  id: string;
  slug: string;
  titular: string;
  resumen: string;
  autor: string;
  etiquetas: string;
  cuerpo: string;
  publicado: number;
  creado_en: string;
  actualizado_en: string;
  /** 'pagina' = archivo HTML entero que subio el dueno (se sirve tal cual). */
  formato?: string | null;
};

/* Cómo se publica un artículo de la base:
 *   pagina -> el HTML tal cual (lo que subió el dueño)
 *   texto  -> Markdown simple del editor
 */
export const BLOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS blog_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  idioma TEXT NOT NULL DEFAULT 'es',
  titular TEXT NOT NULL,
  resumen TEXT NOT NULL DEFAULT '',
  autor TEXT NOT NULL DEFAULT '',
  etiquetas TEXT NOT NULL DEFAULT '',
  cuerpo TEXT NOT NULL,
  publicado INTEGER NOT NULL DEFAULT 0,
  borrado INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
`;

/** Slug a partir del título: sin tildes, minúsculas, guiones. */
export function slugDe(titulo: string): string {
  return String(titulo || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

/* Un <style> que viene de un archivo subido no puede escaparse de su bloque:
 * si trae "</style>" (o el bloque se corta), se corta ahí mismo. */
function cssDeArchivo(css: string): string {
  return String(css || "").replace(/<\/style/gi, "").replace(/<!\-/g, "").replace(/<script/gi, "");
}

/** Markdown mínimo y seguro: escapa HTML y aplica títulos, negrita, listas y párrafos. */
export function markdownAHtml(md: string): string {
  const escapar = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const lineas = String(md || "").replace(/\r/g, "").split("\n");
  const salida: string[] = [];
  let enLista = false;

  const cerrarLista = () => {
    if (enLista) {
      salida.push("</ul>");
      enLista = false;
    }
  };

  for (const cruda of lineas) {
    const l = cruda.trim();
    if (!l) {
      cerrarLista();
      continue;
    }
    const titulo = l.match(/^(#{1,4})\s+(.*)$/);
    if (titulo) {
      cerrarLista();
      const n = Math.min(titulo[1].length + 1, 5); // el h1 lo pone la página
      salida.push("<h" + n + ">" + enLinea(escapar(titulo[2])) + "</h" + n + ">");
      continue;
    }
    if (/^([-*•]|\d+\.)\s+/.test(l)) {
      if (!enLista) {
        salida.push("<ul>");
        enLista = true;
      }
      salida.push("<li>" + enLinea(escapar(l.replace(/^([-*•]|\d+\.)\s+/, ""))) + "</li>");
      continue;
    }
    if (l.startsWith(">")) {
      cerrarLista();
      salida.push("<blockquote>" + enLinea(escapar(l.replace(/^>\s?/, ""))) + "</blockquote>");
      continue;
    }
    cerrarLista();
    salida.push("<p>" + enLinea(escapar(l)) + "</p>");
  }
  cerrarLista();
  return salida.join("\n");
}

/** Formato dentro de una línea: **negrita**, *cursiva*, [texto](url). */
function enLinea(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/* ====================== lectura publica ====================== */

/* Tipos mínimos de D1. */
type D1Sentencia = {
  bind: (...v: unknown[]) => D1Sentencia;
  run: () => Promise<unknown>;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
};
type D1 = { prepare: (sql: string) => D1Sentencia; exec: (sql: string) => Promise<unknown> };

type EnvPub = { DB: D1 };

type D1Fila = {
  slug: string;
  idioma: string;
  titular: string;
  resumen: string;
  autor: string;
  etiquetas: string;
  cuerpo: string;
  actualizado_en: string;
  formato: string;
};

const SITIO = "https://www.ricardosanjur.com";

/* Los articulos de la base se sirven en /blog-api/<slug> (idioma por ?idioma=en):
 * /blog/<slug> lo atiende el sitio del repo, y no queremos pisarlo. */
function URL_POST(esEn: boolean, slug: string): string {
  return "/blog-api/" + slug + (esEn ? "?idioma=en" : "");
}
function URL_LISTA(esEn: boolean): string {
  return esEn ? "/blog-api?idioma=en" : "/blog-api";
}

function hm(v: unknown): string {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fechaBonita(iso: string): string {
  const d = new Date(String(iso || "").slice(0, 10) + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  return d.getUTCDate() + " de " + meses[d.getUTCMonth()] + " de " + d.getUTCFullYear();
}

async function postsPublicados(db: D1, idioma: string): Promise<D1Fila[]> {
  try {
    const r = await db
      .prepare("SELECT slug, idioma, titular, resumen, autor, etiquetas, cuerpo, actualizado_en, COALESCE(formato, 'texto') AS formato FROM blog_posts WHERE publicado = 1 AND borrado = 0 AND idioma = ? ORDER BY actualizado_en DESC")
      .bind(idioma)
      .all<D1Fila>();
    return r.results || [];
  } catch {
    return []; // sin tabla todavía: el sitio sigue mostrando los .md
  }
}

/* ================= lo que se le suma a la página del sitio =================
 * La página la arma el repo (menú, pie, tarjetas de los .md). Lo de la base se
 * inyecta al final del <body>: la tarjeta nueva en el índice y el artículo
 * completo (con los estilos del blog) en /blog/<dirección>.
 */

const NUBE_CSS_EXTRA =
  '.nube-blog .tarjeta{max-width:820px;margin:18px auto}' +
  '.nube-blog .post{max-width:820px;margin:0 auto;font-family:Georgia,"Times New Roman",serif;color:#1c2b33;line-height:1.65}' +
  '.nube-blog .post h1{font-size:clamp(26px,4.4vw,38px);line-height:1.18;color:#123b4a;margin:18px 0 10px}' +
  '.nube-blog .post .volver a{color:#157377;text-decoration:none;font-weight:600}';

/** Lo que se le agrega a /blog (índice): las tarjetas de los artículos de la base. */
/** GET /blog-api -> lista de artículos de la base (JSON de la página /blog-api). */
export async function handleBlogIndex(env: EnvPub, idioma: string): Promise<Response> {
  const posts = await postsPublicados(env.DB, idioma);
  const esEn = idioma === "en";
  const body = '<main class="nube-blog blog-env"><div class="grid-blog">' +
    posts.map((p) => tarjetaHtml(p, esEn)).join("") +
    '</div><p class="volver"><a href="/blog/">← ' + (esEn ? "Back to the blog" : "Volver al blog") + "</a></p></main>";
  return paginaHtml((esEn ? "Technical Blog" : "Blog técnico") + " | Topografía Especializada",
    esEn ? "Articles about land surveying, geodesy and geomatics in Panama." : "Artículos sobre topografía, geodesia y geomática en Panamá.",
    esEn ? "/en/blog" : "/blog", body);
}

/** GET /blog/<slug>/<archivo> -> una foto o archivo que subió el dueño con su artículo. */
type R2Obj = {
  body: ReadableStream | null;
  size?: number;
  httpMetadata?: { contentType?: string };
};
export async function handleBlogArchivo(env: EnvPub & { PLANOS?: { get: (k: string) => Promise<R2Obj | null> } }, slug: string, archivo: string): Promise<Response> {
  if (!env.PLANOS || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(archivo) || archivo.indexOf("..") > -1) {
    return new Response("No encontrado", { status: 404 });
  }
  let obj: R2Obj | null = null;
  try {
    obj = await env.PLANOS.get("blog/" + slug + "/" + archivo);
  } catch {
    obj = null;
  }
  if (!obj || !obj.body) return new Response("No encontrado", { status: 404 });
  const tipo = (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream";
  return new Response(obj.body, {
    headers: { "content-type": tipo, "cache-control": "public, max-age=3600" }
  });
}

export async function handleBlogTarjeta(env: EnvPub, idioma: string, slug: string): Promise<string | null> {
  if (slug) {
    // Artículo suelto: lo arma handleBlogPostHtml (dentro de la página del sitio).
    const p = await filaPublicada(env, idioma, slug);
    return p ? "" : null;
  }
  const posts = await postsPublicados(env.DB, idioma);
  if (!posts.length) return null;
  const esEn = idioma === "en";
  // Un bloque después del de las tarjetas del repo (no hay lista que tocar a mano).
  return '<section class="nube-blog" style="max-width:820px;margin:0 auto 40px;padding:0 18px">' +
    '<div class="grid-blog">' + posts.map((p) => tarjetaHtml(p, esEn)).join("") + "</div></section>";
}

function tarjetaHtml(p: D1Fila, esEn: boolean): string {
  const url = "/blog/" + p.slug + "/";
  return '<article class="tarjeta nube-tarjeta">' +
    '<p class="fecha">' + hm(fechaBonita(p.actualizado_en)) + "</p>" +
    "<h2><a href=\"" + url + '">' + hm(p.titular) + "</a></h2>" +
    (p.resumen ? '<p class="resumen">' + hm(p.resumen) + "</p>" : "") +
    (p.etiquetas ? '<p class="tags">' + p.etiquetas.split(",").map((t) => "<span>" + hm(t.trim()) + "</span>").join("") + "</p>" : "") +
    '<a class="leer" href="' + url + '">' + (esEn ? "Read article" : "Leer artículo") + " →</a>" +
    "</article>";
}

async function filaPublicada(env: EnvPub, idioma: string, slug: string): Promise<D1Fila | null> {
  try {
    return await env.DB.prepare(
      "SELECT slug, idioma, titular, resumen, autor, etiquetas, cuerpo, actualizado_en, COALESCE(formato, 'texto') AS formato FROM blog_posts WHERE slug = ? AND publicado = 1 AND borrado = 0 AND idioma = ?"
    )
      .bind(slug, idioma)
      .first<D1Fila>();
  } catch {
    return null;
  }
}

/** El artículo de la base como bloque para inyectar en la página del sitio (sin <html>). */
export async function handleBlogPostHtml(env: EnvPub, idioma: string, slug: string): Promise<string | null> {
  const p = await filaPublicada(env, idioma, slug);
  if (!p) return null;
  return articuloDe(p, idioma === "en");
}

/** GET /blog  y  /en/blog  -> suma los artículos de la base a los del repo. *//** GET /blog-api/<slug> -> el artículo de la base como página completa (para apps). */
export async function handleBlogPost(env: EnvPub, idioma: string, slug: string): Promise<Response | null> {
  const p = await filaPublicada(env, idioma, slug);
  if (!p) return null;
  const esEn = idioma === "en";
  return paginaHtml(p.titular + " | Topografía Especializada", p.resumen || p.titular, "/blog/" + p.slug, articuloDe(p, esEn));
}

/** El artículo (cabecera con la nota de consulta al pie + cuerpo) como HTML suelto. */
function articuloDe(p: D1Fila, esEn: boolean): string {
  const url = (esEn ? SITIO + "/en/blog/" : SITIO + "/blog/") + p.slug;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: p.titular,
    description: p.resumen || "",
    datePublished: String(p.actualizado_en || "").slice(0, 10),
    dateModified: String(p.actualizado_en || "").slice(0, 10),
    author: { "@type": "Person", name: p.autor || "Ricardo A. Sanjur A." },
    publisher: { "@type": "Organization", name: "Topografía Especializada S.A.", url: SITIO },
    mainEntityOfPage: url,
    inLanguage: esEn ? "en" : "es-PA"
  };

  let cuerpo = "";
  if (p.formato === "pagina") {
    let doc = String(p.cuerpo || "");
    let extraCss = "";
    const estilo = doc.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    if (estilo) {
      extraCss = cssDeArchivo(estilo.map((b) => b.replace(/^<style[^>]*>|<\/style>$/gi, "")).join("\n"));
      doc = doc.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    }
    doc = doc
      .replace(/<\?xml[^>]*\?>/gi, "")
      .replace(/<!doctype[^>]*>/gi, "")
      .replace(/<\/?html[^>]*>/gi, "")
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
      .replace(/<\/?body[^>]*>/gi, "");
    cuerpo = (extraCss ? '<style>' + extraCss + "</style>" : "") + '<div class="pagina-articulo">' + doc + "</div>";
  } else {
    cuerpo = '<h1>' + hm(p.titular) + "</h1>" +
      '<p class="fecha">' + hm(fechaBonita(p.actualizado_en)) + (p.autor ? " · " + hm(p.autor) : "") + "</p>" +
      '<div class="cuerpo">' + markdownAHtml(p.cuerpo) + "</div>";
  }

  const tags = p.etiquetas
    ? '<p class="tags">' + p.etiquetas.split(",").map((t) => "<span>" + hm(t.trim()) + "</span>").join("") + "</p>"
    : "";

  return '<div class="nube-blog"><main class="blog-env"><article class="post">' +
    '<p class="migas"><a href="/blog/">Blog</a></p>' +
    cuerpo + tags +
    '<p class="volver"><a href="/blog/">← ' + (esEn ? "All articles" : "Todos los artículos") + "</a></p>" +
    "</article></main></div>" +
    '<script type="application/ld+json">' + JSON.stringify(jsonld).replace(/</g, "\\u003c") + "</script>";
}

const CSS_BLOG = `
:root{--tinta:#1c2b33;--mut:#5b6b7a;--linea:#e3e8ee;--crema:#f4f1ea;--verde:#123b4a}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--tinta);font-family:Georgia,'Times New Roman',serif;line-height:1.65}
header.top{border-bottom:1px solid var(--linea);background:#fff}
header.top a{display:inline-block;padding:16px 18px;color:var(--verde);text-decoration:none;font-family:system-ui,sans-serif;font-weight:800;letter-spacing:-.02em}
.blog-env{max-width:820px;margin:0 auto;padding:28px 18px 70px}
.grid-blog{display:grid;gap:18px}
@media(min-width:680px){.grid-blog{grid-template-columns:1fr 1fr}}
.tarjeta{border:1px solid var(--linea);border-radius:16px;padding:20px;background:#fff}
.tarjeta .fecha{font-family:system-ui,sans-serif;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:0 0 8px}
.tarjeta h2{font-size:21px;line-height:1.25;margin:0 0 8px}
.tarjeta h2 a{color:var(--tinta);text-decoration:none}
.tarjeta h2 a:hover{color:var(--verde)}
.resumen{font-size:16px;color:var(--mut);margin:0 0 12px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;padding:0;list-style:none}
.tags span{font-family:system-ui,sans-serif;font-size:12px;font-weight:600;color:var(--verde);background:var(--crema);border-radius:999px;padding:4px 10px}
.leer{font-family:system-ui,sans-serif;font-size:14px;font-weight:700;color:var(--verde);text-decoration:none}
.post h1{font-size:clamp(26px,4.4vw,38px);line-height:1.18;letter-spacing:-.02em;margin:8px 0 10px}
.post .fecha{font-family:system-ui,sans-serif;font-size:14px;color:var(--mut);margin:0 0 18px}
.migas{font-family:system-ui,sans-serif;font-size:14px;margin:0 0 10px}
.migas a{color:var(--mut);text-decoration:none}
.cuerpo{font-size:18px}
.cuerpo h2{font-size:24px;line-height:1.25;margin:34px 0 10px;letter-spacing:-.01em}
.cuerpo h3{font-size:19px;margin:26px 0 8px}
.cuerpo p{margin:0 0 16px}
.cuerpo ul{margin:0 0 18px;padding-left:22px}
.cuerpo li{margin-bottom:8px}
.cuerpo blockquote{margin:22px 0;padding:14px 18px;border-left:4px solid var(--verde);background:var(--crema);font-style:italic}
.cuerpo a{color:var(--verde)}
.volver{font-family:system-ui,sans-serif;font-size:15px;margin-top:34px}
.volver a{color:var(--verde);text-decoration:none;font-weight:600}
`;

export const NUBE_CSS = "<style>" + CSS_BLOG + NUBE_CSS_EXTRA + "</style>";

function paginaHtml(titulo: string, descripcion: string, ruta: string, body: string, extraCss = ""): Response {
  const html =
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + hm(titulo) + "</title>" +
    '<meta name="description" content="' + hm(descripcion) + '">' +
    '<link rel="canonical" href="' + SITIO + ruta + '">' +
    '<meta property="og:type" content="article"><meta property="og:title" content="' + hm(titulo) + '">' +
    '<meta property="og:description" content="' + hm(descripcion) + '">' +
    '<meta property="og:url" content="' + SITIO + ruta + '">' +
    '<meta property="og:image" content="' + SITIO + '/og/og-default.jpg">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    '<style>' + CSS_BLOG + extraCss + "</style></head><body>" +
    '<header class="top"><a href="' + SITIO + '/">Topografía Especializada</a></header>' +
    body +
    "</body></html>";
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" }
  });
}
