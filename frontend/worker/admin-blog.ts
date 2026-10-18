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

/** Tope de la carpeta de fotos de un artículo: 25 MB entre todas. */
const MAX_FOTOS_BYTES = 25 * 1024 * 1024;

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
  // Todo lo que se ve en el panel vive en la base (los artículos que estaban como
  // archivo se pasan solos la primera vez, ver sembrarArticulos en index.ts).
  filas.sort((a, b) => String(b.actualizado_en || "").localeCompare(String(a.actualizado_en || "")));

  const accion = '<a class="btn sm" href="/admin/' + esc(tok) + '/blog/nuevo">Nuevo articulo</a>';

  let lista = '';
  if (!filas.length) {
    lista = '<div class="empty">Todavia no hay articulos. Cree el primero con "Nuevo articulo".</div>';
  } else {
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      const hrefVista = (f.idioma === "en" ? "/en/blog/" : "/blog/") + f.slug;
      const esPagina = f.formato === "pagina";
      lista += '<tr><td data-l="Titulo"><strong>' + esc(f.titular) + '</strong>' +
        '<div class="muted small">/' + esc(f.idioma === "en" ? "en/blog/" : "blog/") + esc(f.slug) + (esPagina ? ' · archivo HTML' : '') + '</div></td>' +
        '<td data-l="Estado">' + (Number(f.publicado) ? '<span class="pill">Publicado</span>' : '<span class="pill tipos">Borrador</span>') + '</td>' +
        '<td data-l="Actualizado" class="muted small">' + esc(String(f.actualizado_en || "").slice(0, 10)) + '</td>' +
        '<td class="acciones"><a class="btn ghost sm" href="/admin/' + esc(tok) + "/blog/" + esc(f.id) + '">Editar</a>' +
        (Number(f.publicado)
          ? '<a class="btn ghost sm" target="_blank" rel="noopener" href="' + esc(hrefVista) + '">Ver</a>'
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
    '<p class="lead">Suba el archivo del articulo (o escribalo como texto), revise la vista previa y guarde. Si marca "Publicado" sale en el sitio al instante.</p>' +
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
    '<button type="button" class="pestana activa" data-tab="archivo">Archivo HTML</button>' +
    '<button type="button" class="pestana" data-tab="texto">Escribir texto</button></div>' +
    '<div class="tab-panel" data-panel="texto" hidden>' +
    '<label for="b-cuerpo">Texto del articulo</label>' +
    '<p class="hint">Formato simple: <span class="code">## Titulo</span> <span class="code">**negrita**</span> <span class="code">- lista</span> <span class="code">&gt; cita</span></p>' +
    '<textarea id="b-cuerpo" name="cuerpo" rows="18" class="editor-texto">' + textoEditor + "</textarea>" +
    '</div>' +
    '<div class="tab-panel" data-panel="archivo">' +
    '<div class="subir" id="zona">' +
    '<label for="b-archivo">Archivo HTML del articulo</label>' +
    '<p class="hint">Elija el archivo <strong>.html</strong> del articulo. Queda igualito: su diseño, sus colores y sus tablas se publican tal cual.</p>' +
    '<input id="b-archivo" type="file" name="archivo" accept=".html,.htm,text/html">' +
    '<p class="hint archivo-msg" id="archivo-msg"></p>' +
    '</div>' +
    '<div class="subir" id="zona-fotos">' +
    '<label for="b-fotos">Fotos del articulo <span class="muted">(opcional)</span></label>' +
    '<p class="hint">Si el documento usa fotos, elija tambien la carpeta donde estan (o las fotos sueltas). Quedan guardadas con el articulo y el documento las encuentra solo.</p>' +
    '<input id="b-fotos" type="file" name="adjuntos" multiple accept="image/*,.css,.js,.woff,.woff2,.ttf,.otf">' +
    '<p class="hint archivo-msg" id="fotos-msg"></p>' +
    '</div>' +
    '<p class="hint" id="archivo-estado">' + (formato === "pagina" && f ? "Este articulo se publica desde su archivo HTML. Si sube otro, lo reemplaza. " : "") +
    'Para publicar solo texto, use la pestaña "Escribir texto".</p>' +
    (formato === "pagina" && f ? '<label class="switch"><input type="checkbox" name="quitar_archivo" value="1"> Quitar el archivo HTML y publicar el texto</label>' : '') +
    '</div>' +
    '<div class="row" style="margin-top:16px;justify-content:flex-start">' +
    '<label class="switch"><input type="checkbox" name="publicado" value="1"' + (Number(f?.publicado) ? " checked" : "") + '> Publicado</label>' +
    "</div>" +
    '<div class="acciones-movil" style="margin-top:16px">' +
    (formato === "pagina" && f ? '' : '<button class="btn ghost" type="button" id="ver">Actualizar vista previa</button>') +
    '<button class="btn" type="submit">Guardar</button></div>' +
    "</div>" +
    '<div class="card previa-card" id="previa-card"><div class="sec"><div class="h"><h2>Vista previa</h2><span class="pill tipos" id="previa-tipo">' + (formato === "pagina" && f ? "Asi se ve en el sitio" : "Como se vera") + '</span></div></div>' +
    (formato === "pagina" && f
      ? '<iframe class="previa-marco" id="previa-marco" title="Vista previa del articulo" src="' + esc((idioma === "en" ? "/en/blog/" : "/blog/") + f.slug) + '"></iframe>' +
        '<p class="hint"><a href="' + esc((idioma === "en" ? "/en/blog/" : "/blog/") + f.slug) + '" target="_blank" rel="noopener">Abrir en una pestaña nueva</a></p>'
      : '<div class="previa-articulo" id="previa"></div>') +
    "</div>" +
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
    "function pesos(n){return n<1024?'menos de 1 KB':(n<1048576?Math.round(n/1024)+' KB':(Math.round(n/1048576*10)/10)+' MB');}" +
    "function decir(id,msg){var e=document.getElementById(id);if(e){e.textContent=msg;}}" +
    "var ar=document.getElementById('b-archivo');" +
    "function ponerArchivo(f){if(!f)return;decir('archivo-msg','Archivo elegido: '+f.name+' ('+pesos(f.size)+'). Se publica al guardar.');" +
    "if(ti&&!ti.value.trim()){var n=f.name.replace(/\\.html?$/i,'').replace(/[-_]+/g,' ');ti.value=n.charAt(0).toUpperCase()+n.slice(1);if(ti.dispatchEvent)ti.dispatchEvent(new Event('input'));}}" +
    "if(ar){ar.addEventListener('change',function(){ponerArchivo(ar.files&&ar.files[0]);});}" +
    "var fo=document.getElementById('b-fotos');" +
    "function decirFotos(fs){var n=fs?fs.length:0;if(!n)return;var tot=0;for(var i=0;i<n;i++){tot+=fs[i].size;}decir('fotos-msg',n+(n===1?' archivo':' archivos')+' ('+pesos(tot)+'). Se guardan con el articulo.');}" +
    "if(fo){fo.addEventListener('change',function(){decirFotos(fo.files);});}" +
    "var zona=document.getElementById('zona'),zonaF=document.getElementById('zona-fotos');" +
    "function soltar(el,alSoltar){if(!el)return;['dragenter','dragover'].forEach(function(ev){el.addEventListener(ev,function(e){e.preventDefault();el.classList.add('encima');});});['dragleave','drop'].forEach(function(ev){el.addEventListener(ev,function(e){e.preventDefault();el.classList.remove('encima');});});el.addEventListener('drop',function(e){var fs=e.dataTransfer&&e.dataTransfer.files;if(fs&&fs.length){alSoltar(fs);}});}" +
    "soltar(zona,function(fs){for(var i=0;i<fs.length;i++){if(/\\.html?$/i.test(fs[i].name)){var dt=new DataTransfer();dt.items.add(fs[i]);if(ar){ar.files=dt.files;}ponerArchivo(fs[i]);return;}}alert('Suelte el archivo .html del articulo.');});" +
    "soltar(zonaF,function(fs){if(!fo)return;var dt=new DataTransfer();for(var i=0;i<fs.length;i++){dt.items.add(fs[i]);}fo.files=dt.files;decirFotos(fs);});" +
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

/* ================== archivos del artículo ==================
 * El dueño sube su HTML junto a la carpeta de fotos que usa ("Insertar" en el
 * editor de documentos saca imágenes de esa carpeta). Todo se guarda en R2 bajo
 * blog/<dirección>/ y el HTML se reescribe para que encuentre sus imágenes en el
 * sitio. Así el artículo queda editable desde el panel (no es un archivo del repo).
 */
const EXT_ARTICULO: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  css: "text/css", js: "text/javascript", json: "application/json", txt: "text/plain",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
};

/** Reescribe las rutas del HTML para que las fotos salgan de blog/<dir>/<archivo>. */
function reescribirRutas(html: string, slug: string, nombres: Set<string>): string {
  const base = "/blog/" + slug + "/";
  return html.replace(/(src|srcset|href|poster)\s*=\s*(["'])([^"']*)\2/gi, (todo, attr, q, valor) => {
    // Varios srcset: se procesa cada parte
    const partes = String(valor).split(",");
    let cambio = false;
    const nuevos = partes.map((parte) => {
      const trozos = parte.trim().split(/\s+/);
      const limpio = decodeURIComponent((trozos[0] || "").split(/[?#]/)[0]).replace(/^(file:|https?:\/\/file:\/+)/i, "");
      const nombre = limpio.split(/[\\/]/).pop() || "";
      if (nombre && nombres.has(nombre) && !/^https?:/i.test(trozos[0]) && !trozos[0].startsWith("/blog/")) {
        cambio = true;
        trozos[0] = base + encodeURIComponent(nombre);
        return trozos.join(" ");
      }
      return parte.trim();
    });
    return cambio ? attr + "=" + q + nuevos.join(", ") + q : todo;
  });
}

/** POST /admin/<token>/blog/guardar */
export async function handleBlogGuardar(request: Request, env: Env, tok: string): Promise<Response> {
  await asegurarTabla(env.DB);
  const fd = await request.formData();
  const id = String(fd.get("id") || "").trim();
  if (id && !/^art[0-9a-f]{8,20}$/.test(id)) {
    return new Response(null, { status: 303, headers: { location: "/admin/" + tok + "/blog?aviso=" + encodeURIComponent("Ese artículo ya no existe. Cree uno nuevo.") } });
  }
  const titular = String(fd.get("titular") || "").trim();
  const idioma = String(fd.get("idioma") || "es") === "en" ? "en" : "es";
  const resumen = String(fd.get("resumen") || "").trim();
  const autor = String(fd.get("autor") || "").trim();
  const etiquetas = String(fd.get("etiquetas") || "").trim();
  const publicado = fd.get("publicado") ? 1 : 0;
  const quitarArchivo = !!fd.get("quitar_archivo");
  const textoEditor = String(fd.get("cuerpo") || "").trim();

  let volverA = "/admin/" + tok + "/blog" + (id ? "/" + id : "/nuevo");
  const fallar = (mensaje: string) =>
    new Response(null, { status: 303, headers: { location: volverA + "?aviso=" + encodeURIComponent(mensaje) } });

  // Lo que había antes (si se está editando)
  let previo: { slug: string; formato: string | null; cuerpo: string; cuerpo_texto: string | null } | null = null;
  if (id) {
    previo = await env.DB.prepare("SELECT slug, formato, cuerpo, cuerpo_texto FROM blog_posts WHERE id=? AND borrado=0").bind(id).first();
  }

  if (!titular) return fallar("Falta el título.");

  // Dirección: la escribe o sale del título. Se arma ANTES de guardar archivos
  // porque la carpeta de fotos lleva la dirección. Si ya existe, no cambia.
  let slug = previo ? String(previo.slug) : (slugDe(String(fd.get("slug") || "").trim() || titular) || "articulo").slice(0, 70);

  // --- Archivos: el HTML y la carpeta de fotos ---
  const archivoHtml = fd.get("archivo");
  const fotos = fd.getAll("adjuntos").filter((x) => typeof x !== "string" && (x as File).size > 0) as File[];
  const paginaSubida = archivoHtml && typeof archivoHtml !== "string" && (archivoHtml as File).size > 0;
  const teniaPagina = !!previo && previo.formato === "pagina";
  const publicaPagina = paginaSubida || (teniaPagina && !quitarArchivo);

  let cuerpoPagina = paginaSubida ? "" : previo && teniaPagina ? String(previo.cuerpo || "") : "";
  if (paginaSubida) {
    const f = archivoHtml as File;
    if (!/\.html?$/i.test(String(f.name || ""))) return fallar("El archivo tiene que ser .html (.htm también sirve). Renuévelo");
    if (f.size > MAX_HTML_BYTES) return fallar("El archivo pesa más de 2 MB. Saque las fotos grandes del documento y vuelva a guardarlo.");
    const leido = String(await f.text());
    if (!/<[a-z!][\s\S]*>/i.test(leido)) return fallar("Ese archivo no parece HTML.");
    cuerpoPagina = leido;
  }
  if (!publicaPagina && !textoEditor) return fallar("Falta el contenido: suba el archivo HTML o escriba el texto.");

  if (!env.PLANOS && (fotos.length || paginaSubida)) return fallar("El almacenamiento de archivos no está disponible ahora.");

  if (fotos.length || (paginaSubida && publicaPagina)) {
    if (env.PLANOS) {
      const nombres = new Set<string>();
      let bytes = 0;
      for (const foto of fotos) {
        // Nombre tal como lo nombró él (el HTML lo busca así), sin rutas ni cosas raras.
        let nombre = String(foto.name || "").split(/[\\/]/).pop() || "";
        nombre = nombre.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^[.]+/, "").slice(-120);
        const ext = (nombre.split(".").pop() || "").toLowerCase();
        if (!nombre || !EXT_ARTICULO[ext]) continue;
        bytes += foto.size;
        if (bytes > MAX_FOTOS_BYTES) return fallar("Las fotos suman más de 25 MB. Quite alguna o achíquelas y vuelva a guardar.");
        nombres.add(nombre);
        try {
          await env.PLANOS.put("blog/" + slug + "/" + nombre, await foto.arrayBuffer(), {
            httpMetadata: { contentType: EXT_ARTICULO[ext] },
          });
        } catch (e) {
          console.log("[blog] no se pudo guardar la foto " + nombre + ": " + String((e as any) && (e as any).message || e));
          return fallar("No se pudo guardar la foto " + nombre + ". Vuelva a intentarlo.");
        }
      }
      if (paginaSubida) cuerpoPagina = reescribirRutas(cuerpoPagina, slug, nombres);
    }
  }

  // Qué guarda cada columna: `cuerpo` es lo que se publica y `cuerpo_texto` lo
  // escrito en el editor. Van aparte para no perder uno al usar el otro.
  let cuerpoTexto = textoEditor;
  if (publicaPagina && !cuerpoTexto && previo) cuerpoTexto = String(previo.cuerpo_texto || "");
  const cuerpoPublicado = publicaPagina ? cuerpoPagina : textoEditor;
  const formatoFinal = publicaPagina ? "pagina" : "texto";

  const t = ahora();
  if (id) {
    await env.DB.prepare(
      "UPDATE blog_posts SET titular=?, idioma=?, resumen=?, autor=?, etiquetas=?, cuerpo=?, cuerpo_texto=?, formato=?, publicado=?, actualizado_en=? WHERE id=? AND borrado=0"
    )
      .bind(titular, idioma, resumen, autor, etiquetas, cuerpoPublicado, cuerpoTexto, formatoFinal, publicado, t, id)
      .run();
  } else {
    let n = 1;
    const base = slug;
    while (await env.DB.prepare("SELECT id FROM blog_posts WHERE slug=?").bind(slug).first()) {
      n++;
      slug = base + "-" + n;
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
  const cuantas = fotos.length ? " con " + fotos.length + " foto" + (fotos.length === 1 ? "" : "s") : "";
  const aviso = formatoFinal === "pagina"
    ? (publicado ? "Artículo publicado desde el archivo HTML" + cuantas + "." : "Borrador guardado (archivo HTML)" + cuantas + ".")
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
  '.subir{border:1.5px dashed var(--line);border-radius:12px;padding:12px;margin-bottom:12px;background:#fff}',
  '.subir.encima{border-color:var(--brand);background:#EFF4FF}',
  '.previa-marco{width:100%;height:60vh;min-height:360px;border:0;border-radius:10px;background:#fff}',
  'input[type=file]{width:100%;padding:12px;border:1.5px dashed var(--line);border-radius:10px;background:#fff;font:inherit}',
  '.previa-articulo{max-height:60vh;overflow:auto;padding:4px 2px}',
  '.previa-articulo p{margin:0 0 12px;white-space:pre-wrap}',
  '.previa-articulo h2,.previa-articulo h3{font-family:"Space Grotesk",Inter,sans-serif;margin:18px 0 8px}',
  '.previa-articulo ul{margin:0 0 12px 18px;padding:0}',
  '.previa-articulo blockquote{margin:0 0 12px;padding:8px 14px;border-left:3px solid var(--brand);background:var(--soft);color:#344054}',
  '.form-borrar{margin-top:18px;border-top:1px solid var(--line);padding-top:16px}',
  '@media(max-width:860px){.acc-editor{grid-template-columns:1fr}.previa-card{position:static}}',
].join('\n');
