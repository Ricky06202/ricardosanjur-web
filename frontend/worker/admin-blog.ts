/* Editor de blog del panel: /admin/<token>/blog
 *
 * El papá entra por donde ya entra (RS ID o token), escribe el artículo y lo
 * publica. No toca código, no me espera.
 *
 * El cuerpo se escribe en Markdown simple: # para título, **negrita**, - para
 * listas. Al lado tiene la vista previa para confirmar que quedó bien.
 */

import { BLOG_SCHEMA, markdownAHtml, slugDe } from "./blog";
import { CSS, page } from "./index";

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

  const accion = '<a class="btn sm" href="/admin/' + esc(tok) + '/blog/nuevo">Nuevo articulo</a>';

  let lista = '';
  if (!filas.length) {
    lista = '<div class="empty">Todavia no hay articulos. Cree el primero con "Nuevo articulo".</div>';
  } else {
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      lista += '<tr><td data-l="Titulo"><strong>' + esc(f.titular) + '</strong>' +
        '<div class="muted small">/' + esc(f.idioma === "en" ? "en/blog/" : "blog/") + esc(f.slug) + '</div></td>' +
        '<td data-l="Estado">' + (Number(f.publicado) ? '<span class="pill">Publicado</span>' : '<span class="pill tipos">Borrador</span>') + '</td>' +
        '<td data-l="Actualizado" class="muted small">' + esc(String(f.actualizado_en || "").slice(0, 10)) + '</td>' +
        '<td class="acciones"><a class="btn ghost sm" href="/admin/' + esc(tok) + "/blog/" + esc(f.id) + '">Editar</a>' +
        (Number(f.publicado)
          ? '<a class="btn ghost sm" target="_blank" rel="noopener" href="' + esc((f.idioma === "en" ? "/en/blog/" : "/blog/") + f.slug) + '">Ver</a>'
          : "") +
        '</td></tr>';
    }
  }

  const body = '<div class="sec"><h1><span>Blog del sitio</span></h1>' +
    '<div class="row" style="gap:8px"><a class="btn ghost sm" href="/admin">Panel de planos</a>' + accion + '</div></div>' +
    '<p class="lead">Escriba el articulo, mire la vista previa y publica. Sale en el sitio al instante.</p>' +
    (aviso ? '<div class="card okline"><p class="ok" style="margin:0">' + esc(aviso) + '</p></div>' : "") +
    '<div class="card"><div class="sec"><div class="h"><h2>Articulos</h2><span class="pill">' + filas.length + ' en total</span></div></div>' +
    '<div style="overflow-x:auto;margin-top:6px"><table class="tabla-articulos"><thead><tr><th>Titulo</th><th>Estado</th><th>Actualizado</th><th></th></tr></thead>' +
    '<tbody>' + lista + '</tbody></table></div></div>';

  return page('Blog', body, 200, CSS_PANEL);
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

  const body = '<div class="sec"><h1><span>' + (esNuevo ? "Nuevo articulo" : "Editar articulo") + "</span></h1>" +
    '<div class="row" style="gap:8px"><a class="btn ghost sm" href="/admin/' + esc(tok) + '/blog">Volver al blog</a>' +
    (f ? '<a class="btn ghost sm" target="_blank" rel="noopener" href="' + esc((idioma === "en" ? "/en/blog/" : "/blog/") + f.slug) + '">Ver en el sitio</a>' : "") +
    "</div></div>" +
    '<p class="lead">Escriba el texto, revise la vista previa y guarde. Si marca "Publicado" sale en el sitio al instante.</p>' +
    (aviso ? '<div class="card errline"><p class="err small" style="margin:0;font-weight:600">' + esc(aviso) + "</p></div>" : "") +
    '<form method="POST" action="/admin/' + esc(tok) + '/blog/guardar" data-busy="Guardando...">' +
    (f ? '<input type="hidden" name="id" value="' + esc(f.id) + '">' : "") +
    '<div class="acc-editor"><div class="card">' +
    '<label for="b-titulo">Titulo</label><input id="b-titulo" name="titular" required maxlength="160" value="' + valor("titular") + '">' +
    '<div class="grid2"><div><label for="b-idioma">Idioma</label><select id="b-idioma" name="idioma">' +
    '<option value="es"' + (idioma === "es" ? " selected" : "") + ">Espanol</option>" +
    '<option value="en"' + (idioma === "en" ? " selected" : "") + ">Ingles</option></select></div>" +
    '<div><label for="b-autor">Autor</label><input id="b-autor" name="autor" maxlength="80" value="' + esc(f?.autor || "Ricardo A. Sanjur A.") + '"></div></div>' +
    '<label for="b-resumen">Resumen <span class="muted">(lo que se ve en Google y al compartir)</span></label>' +
    '<textarea id="b-resumen" name="resumen" rows="2" maxlength="200">' + valor("resumen") + "</textarea>" +
    '<label for="b-etiquetas">Etiquetas <span class="muted">(separadas por coma)</span></label><input id="b-etiquetas" name="etiquetas" maxlength="160" value="' + valor("etiquetas") + '">' +
    '<label for="b-cuerpo">Texto del articulo</label>' +
    '<p class="hint">Formato simple: <span class="code">## Titulo</span> <span class="code">**negrita**</span> <span class="code">- lista</span> <span class="code">&gt; cita</span></p>' +
    '<textarea id="b-cuerpo" name="cuerpo" rows="18" required class="editor-texto">' + valor("cuerpo") + "</textarea>" +
    '<div class="row" style="margin-top:16px;justify-content:flex-start">' +
    '<label class="switch"><input type="checkbox" name="publicado" value="1"' + (Number(f?.publicado) ? " checked" : "") + '> Publicado</label>' +
    "</div>" +
    '<div class="acciones-movil" style="margin-top:16px">' +
    '<button class="btn ghost" type="button" id="ver">Actualizar vista previa</button>' +
    '<button class="btn" type="submit">Guardar</button></div>' +
    "</div>" +
    '<div class="card previa-card" id="previa-card"><div class="sec"><div class="h"><h2>Vista previa</h2><span class="pill tipos">Como se vera</span></div></div>' +
    '<div class="previa-articulo" id="previa"></div></div>' +
    "</div></form>" +
    (f
      ? '<form method="POST" action="/admin/' + esc(tok) + '/blog/borrar" class="form-borrar" onsubmit="return confirm(\'Sacar este articulo del sitio?\');">' +
        '<input type="hidden" name="id" value="' + esc(f.id) + '">' +
        '<button class="btn ghost sm danger" type="submit">Sacar del sitio</button></form>'
      : "") +
    "<script>" +
    "var t=document.querySelector('textarea[name=cuerpo]');" +
    "var x=document.getElementById('previa');" +
    "var b=document.getElementById('ver');" +
    "function previa(){if(!t||!x)return;var v=t.value.trim();" +
    "if(!v){x.innerHTML='<p class=\\'muted small\\'>Empiece a escribir para ver el articulo aqui.</p>';return;}" +
    "x.textContent=v.split(/\\n\\n+/).join('\\n\\n');}" +
    "if(b){b.addEventListener('click',previa);}" +
    "if(t){var tm=null;t.addEventListener('input',function(){clearTimeout(tm);tm=setTimeout(previa,250);});previa();}" +
    "</script>";

  return page(esNuevo ? "Nuevo articulo" : "Editar articulo", body, 200, CSS_PANEL);
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

/* Estilos propios del blog (se suman a la hoja del panel, que es la misma
 * del resto del admin: nada de un tema oscuro aparte). */
export const CSS_PANEL = [
  '.acc-editor{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:16px;align-items:start}',
  '.acc-editor .card{min-width:0}',
  '.editor-texto{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:14px;line-height:1.6}',
  '.switch{display:flex!important;align-items:center;gap:9px;margin:0!important;font-weight:600!important;color:#344054!important;font-size:.92rem!important}',
  '.switch input{width:20px!important;height:20px!important;accent-color:var(--brand);padding:0!important}',
  '.previa-card{position:sticky;top:78px}',
  '.previa-articulo{max-height:60vh;overflow:auto;padding:4px 2px}',
  '.previa-articulo p{margin:0 0 12px;white-space:pre-wrap}',
  '.previa-articulo h2,.previa-articulo h3{font-family:"Space Grotesk",Inter,sans-serif;margin:18px 0 8px}',
  '.previa-articulo ul{margin:0 0 12px 18px;padding:0}',
  '.previa-articulo blockquote{margin:0 0 12px;padding:8px 14px;border-left:3px solid var(--brand);background:var(--soft);color:#344054}',
  '.form-borrar{margin-top:18px;border-top:1px solid var(--line);padding-top:16px}',
  '@media(max-width:860px){.acc-editor{grid-template-columns:1fr}.previa-card{position:static}}',
].join('\n');
