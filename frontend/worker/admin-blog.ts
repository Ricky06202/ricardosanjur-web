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
  cuerpo_texto?: string | null;
  publicado: number;
  creado_en: string;
  actualizado_en: string;
  formato?: string | null;
};

/* Columna del formato: 'texto' (Markdown del editor) o 'pagina' (archivo HTML). */
const FORMATO_SCHEMA = "ALTER TABLE blog_posts ADD COLUMN formato TEXT NOT NULL DEFAULT 'texto'";

/** Tope del archivo HTML: 2 MB. Más que eso es casi siempre una foto pegada sin achicar. */
const TEXTO_SCHEMA = "ALTER TABLE blog_posts ADD COLUMN cuerpo_texto TEXT";

const MAX_HTML_BYTES = 2 * 1024 * 1024;

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
  try {
    await db.exec(FORMATO_SCHEMA);
  } catch {
    /* ya tiene la columna */
  }
  try {
    await db.exec(TEXTO_SCHEMA);
  } catch {
    /* ya tiene la columna */
  }
}

/** GET /admin/<token>/blog  -> lista + formulario */
export async function handleBlogLista(env: Env, tok: string, aviso: string): Promise<Response> {
  try {
    await asegurarTabla(env.DB);
  } catch (e) {
    return page('Blog', '<div class="card errline"><p class="err" style="margin:0">No se pudo preparar la tabla del blog: ' + esc(String((e as any) && (e as any).message || e)) + '</p></div>', 500, CSS_PANEL);
  }
  let filas: Fila[] = [];
  try {
    const r = await env.DB.prepare(
      "SELECT id, slug, idioma, titular, resumen, autor, etiquetas, cuerpo, cuerpo_texto, COALESCE(formato,'texto') AS formato, publicado, creado_en, actualizado_en " +
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
  // El editor de texto muestra lo que se escribió como texto (no el HTML subido).
  const textoEditor = esc(f ? String((f as any).cuerpo_texto || (f.formato === "pagina" ? "" : f.cuerpo) || "") : "");
  const idioma = f?.idioma || "es";
  const formato = f?.formato === "pagina" ? "pagina" : "texto";

  const body = '<div class="sec"><h1><span>' + (esNuevo ? "Nuevo articulo" : "Editar articulo") + "</span></h1>" +
    '<div class="row" style="gap:8px"><a class="btn ghost sm" href="/admin/' + esc(tok) + '/blog">Volver al blog</a>' +
    (f ? '<a class="btn ghost sm" target="_blank" rel="noopener" href="' + esc((idioma === "en" ? "/en/blog/" : "/blog/") + f.slug) + '">Ver en el sitio</a>' : "") +
    "</div></div>" +
    '<p class="lead">Escriba el texto, revise la vista previa y guarde. Si marca "Publicado" sale en el sitio al instante.</p>' +
    (aviso ? '<div class="card errline"><p class="err small" style="margin:0;font-weight:600">' + esc(aviso) + "</p></div>" : "") +
    '<form method="POST" action="/admin/' + esc(tok) + '/blog/guardar" enctype="multipart/form-data" data-busy="Guardando...">' +
    (f ? '<input type="hidden" name="id" value="' + esc(f.id) + '">' : "") +
    '<div class="acc-editor"><div class="card">' +
    '<label for="b-titulo">Titulo</label><input id="b-titulo" name="titular" required maxlength="160" value="' + valor("titular") + '">' +
    '<label for="b-slug">Direccion del articulo <span class="muted">(el final del enlace que se comparte)</span></label>' +
    (f
      // Ya publicado: la dirección no se cambia (el enlace que se compartió sigue abriendo).
      ? '<div class="slug-linea fija" id="slug-linea"><span>' + (idioma === "en" ? "/en/blog/" : "/blog/") + '</span><input id="b-slug" value="' + esc(f.slug) + '" readonly></div>' +
        '<p class="hint">Esta dirección no cambia: el enlace que ya se compartió sigue siendo el mismo.</p>'
      : '<div class="slug-linea" id="slug-linea"><span>' + (idioma === "en" ? "/en/blog/" : "/blog/") + '</span><input id="b-slug" name="slug" maxlength="70" ' +
        'placeholder="se completa solo con el titulo"></div>' +
        '<p class="hint">Ejemplo: <span class="code">cuanto-cuesta-un-plano</span> &rarr; www.ricardosanjur.com/blog/cuanto-cuesta-un-plano/. Se completa solo con el título; se puede corregir antes de guardar y después ya no cambia.</p>') +
    '<div class="grid2"><div><label for="b-idioma">Idioma</label><select id="b-idioma" name="idioma">' +
    '<option value="es"' + (idioma === "es" ? " selected" : "") + ">Espanol</option>" +
    '<option value="en"' + (idioma === "en" ? " selected" : "") + ">Ingles</option></select></div>" +
    '<div><label for="b-autor">Autor</label><input id="b-autor" name="autor" maxlength="80" value="' + esc(f?.autor || "Ricardo A. Sanjur A.") + '"></div></div>' +
    '<label for="b-resumen">Resumen <span class="muted">(lo que se ve en Google y al compartir)</span></label>' +
    '<textarea id="b-resumen" name="resumen" rows="2" maxlength="200">' + valor("resumen") + "</textarea>" +
    '<label for="b-etiquetas">Etiquetas <span class="muted">(separadas por coma)</span></label><input id="b-etiquetas" name="etiquetas" maxlength="160" value="' + valor("etiquetas") + '">' +
    '<div class="pestanas" role="tablist">' +
    '<button type="button" class="pestana activa" data-tab="texto">Escribir texto</button>' +
    '<button type="button" class="pestana" data-tab="archivo">Subir archivo HTML</button></div>' +
    '<div class="tab-panel" data-panel="texto">' +
    '<label for="b-cuerpo">Texto del articulo</label>' +
    '<p class="hint">Formato simple: <span class="code">## Titulo</span> <span class="code">**negrita**</span> <span class="code">- lista</span> <span class="code">&gt; cita</span></p>' +
    '<textarea id="b-cuerpo" name="cuerpo" rows="18" class="editor-texto">' + textoEditor + "</textarea>" +
    '</div>' +
    '<div class="tab-panel" data-panel="archivo" hidden>' +
    '<label for="b-archivo">Archivo HTML del articulo</label>' +
    '<p class="hint">Seleccione el archivo y el articulo queda <strong>igualito al archivo</strong>: su diseño, sus colores y sus tablas se publican tal cual.</p>' +
    '<input id="b-archivo" type="file" name="archivo" accept=".html,.htm,text/html">' +
    // Nombre del archivo elegido (el navegador pone su propio botón en inglés).
    '<p class="hint archivo-msg" id="archivo-msg"></p>' +
    '<p class="hint" id="archivo-estado">' + (formato === "pagina" && f ? "Este articulo se publica desde un archivo HTML. Si sube otro, lo reemplaza. " : "") +
    'Para volver a editarlo como texto: escribalo en la otra pestaña y marque "Quitar el archivo HTML".</p>' +
    (formato === "pagina" && f ? '<label class="switch"><input type="checkbox" name="quitar_archivo" value="1"> Quitar el archivo HTML y publicar el texto</label>' : '') +
    '</div>' +
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
    "(function(){" +
    "var pest=document.querySelectorAll('.pestana');" +
    "for(var i=0;i<pest.length;i++){pest[i].addEventListener('click',function(){" +
    "var k=this.getAttribute('data-tab');" +
    "for(var j=0;j<pest.length;j++){pest[j].classList.toggle('activa',pest[j]===this);}" +
    "var ps=document.querySelectorAll('.tab-panel');for(var j=0;j<ps.length;j++){ps[j].hidden=ps[j].getAttribute('data-panel')!==k;}" +
    "});}" +
    "var ti=document.getElementById('b-titulo'),sl=document.getElementById('b-slug'),tocado=!!(sl&&sl.value.trim());" +
    "function md(v){return String(v||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70);}" +
    "if(sl){sl.addEventListener('input',function(){tocado=sl.value.trim()!=='';});}" +
    "if(ti&&sl){ti.addEventListener('input',function(){if(!tocado||!sl.value.trim()){sl.value=md(ti.value);}});}" +
    "var ar=document.getElementById('b-archivo');" +
    "if(ar){ar.addEventListener('change',function(){var f=ar.files&&ar.files[0];if(!f)return;var e=document.getElementById('archivo-msg');if(e){e.textContent='Archivo elegido: '+f.name+' ('+(f.size<1024?'menos de 1 KB':Math.round(f.size/1024)+' KB')+'). Se publica al guardar.';}" +
    "if(ti&&!ti.value.trim()){var n=f.name.replace(/\\.html?$/i,'').replace(/[-_]+/g,' ');ti.value=n.charAt(0).toUpperCase()+n.slice(1);if(ti.dispatchEvent)ti.dispatchEvent(new Event('input'));}});}" +
    "})();" +
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
  let cuerpo = String(fd.get("cuerpo") || "").trim();
  const idioma = String(fd.get("idioma") || "es") === "en" ? "en" : "es";
  const resumen = String(fd.get("resumen") || "").trim();
  const autor = String(fd.get("autor") || "").trim();
  const etiquetas = String(fd.get("etiquetas") || "").trim();
  const publicado = fd.get("publicado") ? 1 : 0;
  const quitarArchivo = !!fd.get("quitar_archivo");

  const volverA = "/admin/" + tok + "/blog" + (id ? "/" + id : "/nuevo");

  // Archivo HTML (opcional). Es la pestaña "Subir un archivo HTML".
  let formato = "texto";
  const archivo = fd.get("archivo");
  if (archivo && typeof archivo !== "string" && Number((archivo as File).size) > 0) {
    const f = archivo as File;
    const nombre = String(f.name || "");
    if (!/\.html?$/i.test(nombre)) {
      return new Response(null, { status: 303, headers: { location: volverA + "?aviso=" + encodeURIComponent("El archivo tiene que ser .html (.htm también sirve).") } });
    }
    if (f.size > MAX_HTML_BYTES) {
      return new Response(null, { status: 303, headers: { location: volverA + "?aviso=" + encodeURIComponent("El archivo pesa más de 2 MB. Achique las fotos y vuelva a subirlo.") } });
    }
    const leido = String(await f.text());
    if (!/<[a-z!][\s\S]*>/i.test(leido)) {
      return new Response(null, { status: 303, headers: { location: volverA + "?aviso=" + encodeURIComponent("Ese archivo no parece HTML.") } });
    }
    cuerpo = leido;
    formato = "pagina";
  }

  // Qué guarda cada columna: `cuerpo` es lo que se publica y `cuerpo_texto` lo
  // escrito en el editor. Van aparte para no perder uno al usar el otro.
  // Un artículo que ya era una página sigue siéndolo mientras no se pida quitar
  // el archivo y se escriba texto.
  const textoEditor = String(fd.get("cuerpo") || "").trim();
  const paginaSubida = formato === "pagina";
  let publicadoComoPagina = paginaSubida;
  let cuerpoPublicado = paginaSubida ? cuerpo : textoEditor;
  let cuerpoTexto = paginaSubida ? textoEditor : cuerpoPublicado;

  if (id) {
    const previo = await env.DB.prepare("SELECT formato, cuerpo, cuerpo_texto FROM blog_posts WHERE id=? AND borrado=0").bind(id).first<{ formato: string | null; cuerpo: string; cuerpo_texto: string | null }>();
    const teniaPagina = !!previo && previo.formato === "pagina";
    if (teniaPagina && !quitarArchivo && !paginaSubida) {
      // Se edita los datos (título, resumen, dirección) y sigue publicando el mismo archivo.
      publicadoComoPagina = true;
      cuerpoPublicado = String((previo as any).cuerpo || "");
      if (!cuerpoTexto) cuerpoTexto = String((previo as any).cuerpo_texto || "");
    } else if (paginaSubida && !cuerpoTexto && previo) {
      cuerpoTexto = String((previo as any).cuerpo_texto || "");
    }
  }
  const formatoFinal = publicadoComoPagina ? "pagina" : "texto";

  if (!titular || !cuerpoPublicado) {
    return new Response(null, { status: 303, headers: { location: volverA + "?aviso=" + encodeURIComponent("Falta el título o el contenido (el texto o el archivo HTML).") } });
  }

  // Dirección del artículo (el final del enlace): se escribe a mano o se completa
  // sola con el título al crearlo. Una vez creado NO cambia: así el enlace que ya
  // se compartió o que Google ya conoce sigue abriendo el mismo artículo.
  const slugEscrito = String(fd.get("slug") || "").trim();
  const slugQuerido = (slugDe(slugEscrito || titular) || "articulo").slice(0, 70);
  const t = ahora();

  if (id) {
    await env.DB.prepare(
      "UPDATE blog_posts SET titular=?, idioma=?, resumen=?, autor=?, etiquetas=?, cuerpo=?, cuerpo_texto=?, formato=?, publicado=?, actualizado_en=? WHERE id=? AND borrado=0"
    )
      .bind(titular, idioma, resumen, autor, etiquetas, cuerpoPublicado, cuerpoTexto, formatoFinal, publicado, t, id)
      .run();
  } else {
    let slug = slugQuerido;
    let n = 1;
    while (await env.DB.prepare("SELECT id FROM blog_posts WHERE slug=?").bind(slug).first()) {
      n++;
      slug = slugQuerido + "-" + n;
    }
    // Id corto sin guion extra: la ruta /admin/<token>/blog/<id> solo acepta uno.
    const nuevoId = "art" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await env.DB.prepare(
      "INSERT INTO blog_posts (id, slug, idioma, titular, resumen, autor, etiquetas, cuerpo, cuerpo_texto, formato, publicado, borrado, creado_en, actualizado_en) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)"
    )
      .bind(nuevoId, slug, idioma, titular, resumen, autor, etiquetas, cuerpoPublicado, cuerpoTexto, formatoFinal, publicado, t, t)
      .run();
  }
  const aviso = formatoFinal === "pagina"
    ? (publicado ? "Artículo publicado desde el archivo HTML." : "Borrador guardado (archivo HTML).")
    : (publicado ? "Artículo guardado y publicado." : "Borrador guardado.");
  return new Response(null, { status: 303, headers: { location: "/admin/" + tok + "/blog?aviso=" + encodeURIComponent(aviso) } });
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
  '.slug-linea{display:flex;align-items:stretch;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}',
  '.slug-linea span{display:flex;align-items:center;padding:0 10px;background:var(--soft);color:#475467;font-size:.9rem;border-right:1px solid var(--line);white-space:nowrap}',
  '.slug-linea input{border:0!important;border-radius:0!important;flex:1;min-width:0;margin:0!important}',
  '.slug-linea input:focus{box-shadow:none!important}',
  '.slug-linea.fija{background:#F8FAFC}',
  '.slug-linea.fija input{background:transparent;color:#475467}',
  '.pestanas{display:flex;gap:6px;margin:4px 0 12px;background:var(--soft);padding:4px;border-radius:12px}',
  '.pestana{flex:1;border:0;background:transparent;padding:10px 6px;border-radius:9px;font:inherit;font-weight:600;color:#475467;cursor:pointer;font-size:.86rem;line-height:1.25}',
  '.pestana.activa{background:#fff;color:var(--brand);box-shadow:0 1px 3px rgba(16,24,40,.12)}',
  '.tab-panel[hidden]{display:none}',
  '.archivo-msg:empty{display:none}',
  '.archivo-msg{font-weight:600;color:#067647}',
  'input[type=file]{width:100%;padding:12px;border:1.5px dashed var(--line);border-radius:10px;background:#fff;font:inherit}',
  '.previa-articulo{max-height:60vh;overflow:auto;padding:4px 2px}',
  '.previa-articulo p{margin:0 0 12px;white-space:pre-wrap}',
  '.previa-articulo h2,.previa-articulo h3{font-family:"Space Grotesk",Inter,sans-serif;margin:18px 0 8px}',
  '.previa-articulo ul{margin:0 0 12px 18px;padding:0}',
  '.previa-articulo blockquote{margin:0 0 12px;padding:8px 14px;border-left:3px solid var(--brand);background:var(--soft);color:#344054}',
  '.form-borrar{margin-top:18px;border-top:1px solid var(--line);padding-top:16px}',
  '@media(max-width:860px){.acc-editor{grid-template-columns:1fr}.previa-card{position:static}}',
].join('\n');
