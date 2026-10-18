/* Editor de blog del panel: /admin/<token>/blog
 *
 * El papá entra por donde ya entra (RS ID o token), escribe el artículo y lo
 * publica. No toca código, no me espera.
 *
 * El cuerpo se escribe en Markdown simple: # para título, **negrita**, - para
 * listas. Al lado tiene la vista previa para confirmar que quedó bien.
 */

import { BLOG_SCHEMA, markdownAHtml, slugDe } from "./blog";

/* Tipos mínimos de D1 (el proyecto usa `any` para env.DB en index.ts). */
type D1Sentencia = {
  bind: (...v: unknown[]) => D1Sentencia;
  run: () => Promise<unknown>;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
};

type D1 = {
  prepare: (sql: string) => D1Sentencia;
  exec: (sql: string) => Promise<unknown>;
};

type Env = Record<string, unknown> & { DB: D1 };

type Fila = {
  id: string;
  slug: string;
  idioma: string;
  titular: string;
  resumen: string;
  autor: string;
  etiquetas: string;
  cuerpo: string;
  publicado: number;
  creado_en: string;
  actualizado_en: string;
};

const ahora = () => new Date().toISOString();

function esc(v: unknown): string {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function asegurarTabla(db: D1) {
  try {
    await db.exec(BLOG_SCHEMA);
  } catch {
    /* ya existe */
  }
}

/** GET /admin/<token>/blog  -> lista + formulario */
export async function handleBlogLista(env: Env, tok: string, aviso: string): Promise<Response> {
  await asegurarTabla(env.DB);
  let filas: Fila[] = [];
  try {
    const r = await env.DB.prepare(
      "SELECT id, slug, idioma, titular, resumen, autor, etiquetas, cuerpo, publicado, creado_en, actualizado_en " +
        "FROM blog_posts WHERE borrado = 0 ORDER BY actualizado_en DESC"
    ).all<Fila>();
    filas = r.results || [];
  } catch {
    filas = [];
  }

  const lista = filas.length
    ? filas
        .map(
          (f) =>
            '<tr>' +
            "<td><strong>" + esc(f.titular) + "</strong>" +
            '<div class="muted" style="font-size:.84rem">/' + esc(f.idioma === "en" ? "en/blog/" : "blog/") + esc(f.slug) + "</div></td>" +
            "<td>" + (Number(f.publicado) ? '<span class="pill">Publicado</span>' : '<span class="pill muted">Borrador</span>') + "</td>" +
            '<td class="muted" style="font-size:.84rem">' + esc(String(f.actualizado_en || "").slice(0, 10)) + "</td>" +
            '<td style="white-space:nowrap">' +
            '<a class="btn ghost" href="/admin/' + esc(tok) + "/blog/" + esc(f.id) + '">Editar</a> ' +
            (Number(f.publicado)
              ? '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc((f.idioma === "en" ? "/en/blog/" : "/blog/") + f.slug) + '">Ver</a>'
              : "") +
            "</td></tr>"
        )
        .join("")
    : '<tr><td colspan="4" class="muted">Todavía no escribiste ningún artículo.</td></tr>';

  const body =
    '<h1><span>Blog</span><a class="pill" href="/admin/salir" style="text-decoration:none">Cerrar sesión</a></h1>' +
    '<p class="muted">Escribí el artículo, mirá la vista previa y publicá. Sale en el sitio al instante.</p>' +
    (aviso ? '<div class="card" style="border-color:rgba(120,255,190,.35)"><p class="ok" style="margin:0">' + esc(aviso) + "</p></div>" : "") +
    '<div class="card"><div class="row"><h2>Artículos</h2><a class="btn" href="/admin/' + esc(tok) + '/blog/nuevo">Nuevo artículo</a></div>' +
    '<div style="overflow-x:auto"><table><thead><tr><th>Título</th><th>Estado</th><th>Actualizado</th><th></th></tr></thead>' +
    "<tbody>" + lista + "</tbody></table></div></div>" +
    '<p class="muted"><a href="/admin">Volver al panel de planos</a></p>';

  return new Response(
    '<!doctype html><html lang="es" data-theme="topoblue"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
      "<title>Blog | Panel</title><style>" + CSS_PANEL + "</style></head><body>" +
      '<header class="brand">Topografía Especializada <small>S.A.</small></header><main>' + body + "</main></body></html>",
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

/** GET /admin/<token>/blog/nuevo  o  /admin/<token>/blog/<id> */
export async function handleBlogForm(env: Env, tok: string, id: string, aviso: string): Promise<Response> {
  await asegurarTabla(env.DB);
  let f: Fila | null = null;
  if (id && id !== "nuevo") {
    try {
      f = await env.DB.prepare("SELECT * FROM blog_posts WHERE id = ? AND borrado = 0").bind(id).first<Fila>();
    } catch {
      f = null;
    }
  }

  const esNuevo = !f;
  const valor = (k: keyof Fila, def = "") => esc(f ? (f as unknown as Record<string, unknown>)[k] ?? def : def);
  const idioma = f?.idioma || "es";

  const body =
    '<h1><span>' + (esNuevo ? "Nuevo artículo" : "Editar artículo") + "</span>" +
    '<a class="pill" href="/admin/' + esc(tok) + '/blog" style="text-decoration:none">Volver</a></h1>' +
    (aviso ? '<div class="card" style="border-color:#f0c2bd"><p style="color:#b42318;margin:0">' + esc(aviso) + "</p></div>" : "") +
    '<form method="POST" action="/admin/' + esc(tok) + '/blog/guardar">' +
    (f ? '<input type="hidden" name="id" value="' + esc(f.id) + '">' : "") +
    '<div class="card"><div class="grid2">' +
    "<div><label>Título</label><input name=\"titular\" required maxlength=\"160\" value=\"" + valor("titular") + '"></div>' +
    "<div><label>Idioma</label><select name=\"idioma\">" +
    '<option value="es"' + (idioma === "es" ? " selected" : "") + ">Español</option>" +
    '<option value="en"' + (idioma === "en" ? " selected" : "") + ">Inglés</option>" +
    "</select></div></div>" +
    '<label>Autor</label><input name="autor" maxlength="80" value="' + esc(f?.autor || "Ricardo A. Sanjur A.") + '">' +
    '<label>Resumen (lo que se ve en Google y al compartir)</label>' +
    '<textarea name="resumen" rows="2" maxlength="200">' + valor("resumen") + "</textarea>" +
    '<label>Etiquetas (separadas por coma)</label><input name="etiquetas" maxlength="160" value="' + valor("etiquetas") + '">' +
    '<label>Texto del artículo</label>' +
    '<p class="muted" style="font-size:.84rem;margin:-4px 0 6px">Podés usar: <span class="code">## Título</span>, ' +
    '<span class="code">**negrita**</span>, <span class="code">- lista</span> y <span class="code">> cita</span>.</p>' +
    '<textarea name="cuerpo" rows="18" required style="font-family:ui-monospace,Menlo,monospace;font-size:14px">' + valor("cuerpo") + "</textarea>" +
    '<div class="row" style="margin-top:14px">' +
    '<label style="display:flex;gap:8px;align-items:center;font-weight:600">' +
    '<input type="checkbox" name="publicado" value="1"' + (Number(f?.publicado) ? " checked" : "") + '> Publicado</label>' +
    '<div style="display:flex;gap:8px">' +
    '<button class="btn ghost" type="button" id="ver">Vista previa</button>' +
    '<button class="btn" type="submit">Guardar</button></div></div>' +
    "</div></form>" +
    (f
      ? '<form method="POST" action="/admin/' + esc(tok) + '/blog/borrar" onsubmit="return confirm(\'¿Sacar este artículo del sitio?\');">' +
        '<input type="hidden" name="id" value="' + esc(f.id) + '">' +
        '<button class="btn ghost" style="color:#b42318" type="submit">Sacar del sitio</button></form>'
      : "") +
    '<div class="card" id="previa-card" style="display:none"><h2>Vista previa</h2><div id="previa"></div></div>' +
    "<script>" +
    "var t=document.querySelector('textarea[name=cuerpo]');" +
    "var b=document.getElementById('ver');" +
    "if(b&&t){b.addEventListener('click',function(){var x=document.getElementById('previa');" +
    "if(!x.dataset.hecho){x.innerHTML=t.value.split(/\\n\\n+/).map(function(p){return '<p>'+p.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</p>';}).join('');x.dataset.hecho='1';}" +
    "document.getElementById('previa-card').style.display='block';document.getElementById('previa-card').scrollIntoView({behavior:'smooth'});});}" +
    "</script>";

  return new Response(
    '<!doctype html><html lang="es" data-theme="topoblue"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
      "<title>" + (esNuevo ? "Nuevo artículo" : "Editar artículo") + " | Panel</title><style>" + CSS_PANEL + "</style></head><body>" +
      '<header class="brand">Topografía Especializada <small>S.A.</small></header><main>' + body + "</main></body></html>",
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

/** POST /admin/<token>/blog/guardar */
export async function handleBlogGuardar(request: Request, env: Env, tok: string): Promise<Response> {
  await asegurarTabla(env.DB);
  const fd = await request.formData();
  const id = String(fd.get("id") || "").trim();
  const titular = String(fd.get("titular") || "").trim();
  const cuerpo = String(fd.get("cuerpo") || "").trim();
  const idioma = String(fd.get("idioma") || "es") === "en" ? "en" : "es";
  const resumen = String(fd.get("resumen") || "").trim();
  const autor = String(fd.get("autor") || "").trim();
  const etiquetas = String(fd.get("etiquetas") || "").trim();
  const publicado = fd.get("publicado") ? 1 : 0;

  if (!titular || !cuerpo) {
    return new Response(null, { status: 303, headers: { location: "/admin/" + tok + "/blog" + (id ? "/" + id : "/nuevo") + "?aviso=" + encodeURIComponent("El título y el texto son obligatorios.") } });
  }

  const t = ahora();
  if (id) {
    await env.DB.prepare(
      "UPDATE blog_posts SET titular=?, idioma=?, resumen=?, autor=?, etiquetas=?, cuerpo=?, publicado=?, actualizado_en=? WHERE id=? AND borrado=0"
    )
      .bind(titular, idioma, resumen, autor, etiquetas, cuerpo, publicado, t, id)
      .run();
  } else {
    // slug único: si ya existe, se le agrega un sufijo corto
    let slug = slugDe(titular) || "articulo";
    const existe = await env.DB.prepare("SELECT id FROM blog_posts WHERE slug=?").bind(slug).first();
    if (existe) slug = slug + "-" + Math.random().toString(36).slice(2, 6);
    const nuevoId = "art-" + crypto.randomUUID().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO blog_posts (id, slug, idioma, titular, resumen, autor, etiquetas, cuerpo, publicado, borrado, creado_en, actualizado_en) " +
        "VALUES (?,?,?,?,?,?,?,?,?,0,?,?)"
    )
      .bind(nuevoId, slug, idioma, titular, resumen, autor, etiquetas, cuerpo, publicado, t, t)
      .run();
  }
  return new Response(null, {
    status: 303,
    headers: { location: "/admin/" + tok + "/blog?aviso=" + encodeURIComponent(publicado ? "Artículo guardado y publicado." : "Borrador guardado.") }
  });
}

/** POST /admin/<token>/blog/borrar -> marca borrado (no destruye) */
export async function handleBlogBorrar(request: Request, env: Env, tok: string): Promise<Response> {
  await asegurarTabla(env.DB);
  const fd = await request.formData();
  const id = String(fd.get("id") || "").trim();
  if (id) {
    await env.DB.prepare("UPDATE blog_posts SET borrado=1, actualizado_en=? WHERE id=?").bind(ahora(), id).run();
  }
  return new Response(null, { status: 303, headers: { location: "/admin/" + tok + "/blog?aviso=" + encodeURIComponent("Artículo sacado del sitio.") } });
}

const CSS_PANEL = `
:root{--bg:#0b1220;--card:#121c2c;--line:#22314a;--ink:#e8eef6;--mut:#93a4bb;--brand:#2563eb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;line-height:1.5}
.brand{padding:14px 18px;font-weight:800;letter-spacing:-.02em;border-bottom:1px solid var(--line)}
.brand small{color:var(--mut);font-weight:600}
main{max-width:900px;margin:0 auto;padding:18px 16px 60px}
h1{font-size:22px;display:flex;justify-content:space-between;align-items:center;gap:10px;margin:8px 0 6px}
h2{font-size:16px;margin:0 0 8px}
.muted{color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:14px 0}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
label{display:block;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:12px 0 5px}
input,select,textarea{width:100%;padding:11px 12px;font-size:16px;border-radius:10px;border:1px solid var(--line);background:#0e1725;color:var(--ink)}
textarea{resize:vertical}
.grid2{display:grid;grid-template-columns:1fr;gap:10px}
@media(min-width:640px){.grid2{grid-template-columns:1fr 1fr}}
.btn{display:inline-block;padding:11px 16px;min-height:42px;border-radius:10px;border:1px solid var(--brand);background:var(--brand);color:#fff;font-weight:700;font-size:15px;text-decoration:none;cursor:pointer}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.pill{display:inline-block;padding:5px 10px;border-radius:999px;border:1px solid var(--line);font-size:12px;font-weight:700}
.pill.muted{color:var(--mut)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.code{font-family:ui-monospace,Menlo,monospace;background:#0e1725;padding:1px 5px;border-radius:5px}
.ok{color:#34d399}
#previa p{white-space:pre-wrap}
`;
