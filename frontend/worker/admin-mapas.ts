import { CSS_PANEL } from './admin-blog';
import { page } from './index';
import {
  backendRequest,
  cleanMapText,
  ensureMapasTable,
  MAX_MAPA_BYTES,
  slugFromTitle,
  validCaptureDate,
  type MapaRow,
  type MapasEnv,
} from './mapas';

type AdminEnv = MapasEnv & { ADMIN_EMAILS?: string; ADMIN_TOKEN?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] || char));
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

function avisoUrl(message: string, id?: string): string {
  return `/admin/mapas${id ? `/${encodeURIComponent(id)}` : ''}?aviso=${encodeURIComponent(message)}`;
}

function formularioEliminarMapa(id: string, className = ''): string {
  const classAttr = className ? ' class="' + esc(className) + '"' : '';
  return '<form' + classAttr + ' method="POST" action="/admin/mapas/' + esc(id) + '/eliminar" data-busy="Eliminando..." ' +
    'onsubmit="return confirm(\'Se eliminarán permanentemente la ficha y el archivo MBTiles del servidor. Esta acción no se puede deshacer.\')">' +
    '<button class="btn ghost sm danger" type="submit">Eliminar definitivamente</button></form>';
}

function formatBytes(value: unknown): string {
  let bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1000 && i < units.length - 1) { bytes /= 1000; i++; }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function prettyDate(value: unknown): string {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'Sin fecha';
  const [year, month, day] = text.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('es-PA', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function estadoLabel(estado: string): string {
  if (estado === 'publicado') return 'Publicado';
  if (estado === 'archivado') return 'Archivado';
  return 'Borrador';
}

function estadoClase(estado: string): string {
  if (estado === 'publicado') return 'mapa-estado mapa-publicado';
  if (estado === 'archivado') return 'mapa-estado mapa-archivado';
  return 'mapa-estado mapa-borrador';
}

function maxUploadBytes(env: AdminEnv): number {
  const configured = Number(env.MAPAS_MAX_UPLOAD_BYTES || MAX_MAPA_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : MAX_MAPA_BYTES;
}

function cardError(message: string): string {
  return '<div class="card errline"><p class="err small" style="margin:0;font-weight:600">' + esc(message) + '</p></div>';
}

export async function handleAdminMapaLista(env: AdminEnv, aviso = ''): Promise<Response> {
  try {
    await ensureMapasTable(env.DB);
    const result = await env.DB.prepare(
      'SELECT id, slug, titulo, descripcion, lugar, fecha_captura, archivo_nombre, archivo_tamano, formato, minzoom, maxzoom, bounds_json, center_json, estado, creado_por, creado_en, actualizado_en, subido_en FROM ortomosaicos ORDER BY actualizado_en DESC',
    ).all<MapaRow>();
    const rows = result.results || [];
    const cards = rows.map((mapa: MapaRow) => {
      const fileLine = mapa.archivo_nombre
        ? '<p class="mapa-meta">MBTiles · ' + esc(formatBytes(mapa.archivo_tamano)) + ' · ' + esc(String(mapa.formato || '').toUpperCase()) + '</p>'
        : '<p class="mapa-meta">Todavía falta subir el archivo MBTiles.</p>';
      const deleteForm = mapa.estado === 'archivado' ? formularioEliminarMapa(mapa.id) : '';
      return '<article class="card mapa-admin-card">' +
        '<div class="mapa-admin-top"><span class="' + estadoClase(mapa.estado) + '">' + esc(estadoLabel(mapa.estado)) + '</span>' +
        '<span class="mapa-meta">' + esc(prettyDate(mapa.fecha_captura)) + '</span></div>' +
        '<h2>' + esc(mapa.titulo) + '</h2><p class="mapa-meta">' + esc(mapa.lugar) + '</p>' +
        (mapa.descripcion ? '<p class="mapa-admin-desc">' + esc(mapa.descripcion) + '</p>' : '') + fileLine +
        '<div class="row mapa-admin-actions" style="gap:8px"><a class="btn sm" href="/admin/mapas/' + esc(mapa.id) + '">Administrar</a>' +
        (mapa.estado === 'publicado' ? '<a class="btn ghost sm" href="/mapas/' + esc(mapa.slug) + '/" target="_blank" rel="noopener">Ver en el sitio</a>' : '') +
        deleteForm + '</div></article>';
    }).join('');

    const body = '<div class="sec"><h1><span>Ortomosaicos</span></h1><a class="btn sm" href="/admin/mapas/nuevo">Nuevo mapa</a></div>' +
      '<p class="lead">Suba los MBTiles aquí. Los borradores no son públicos; archivar los oculta sin borrar el archivo del VPS.</p>' +
      (aviso ? '<div class="card okline"><p class="ok" style="margin:0">' + esc(aviso) + '</p></div>' : '') +
      '<div class="mapa-admin-resumen"><div><strong>' + rows.length + '</strong><span>mapas registrados</span></div>' +
      '<div><strong>' + rows.filter((mapa: MapaRow) => mapa.estado === 'publicado').length + '</strong><span>públicos</span></div>' +
      '<div><strong>' + rows.filter((mapa: MapaRow) => mapa.archivo_nombre).length + '</strong><span>archivos cargados</span></div></div>' +
      (rows.length ? '<div class="mapa-admin-grid">' + cards + '</div>' :
        '<div class="card empty"><h2>La biblioteca está vacía</h2><p>Agregue el primer ortomosaico para que aparezca aquí y pueda publicarlo.</p>' +
        '<p style="margin-top:14px"><a class="btn" href="/admin/mapas/nuevo">Agregar mapa</a></p></div>');

    return page('Administrar ortomosaicos', body, 200, CSS_PANEL + MAPAS_ADMIN_CSS, { token: env.ADMIN_TOKEN, section: 'mapas' });
  } catch {
    return page('Administrar ortomosaicos', cardError('No se pudo cargar la biblioteca de mapas.'), 500, CSS_PANEL + MAPAS_ADMIN_CSS, { token: env.ADMIN_TOKEN, section: 'mapas' });
  }
}

export async function handleAdminMapaForm(env: AdminEnv, id: string, aviso = ''): Promise<Response> {
  const esNuevo = id === 'nuevo';
  const maxBytes = maxUploadBytes(env);
  let mapa: MapaRow | null = null;
  if (!esNuevo) {
    if (!UUID_RE.test(id)) return page('Mapa no encontrado', cardError('El enlace del mapa no es válido.'), 404, CSS_PANEL + MAPAS_ADMIN_CSS, { token: env.ADMIN_TOKEN, section: 'mapas' });
    try {
      await ensureMapasTable(env.DB);
      mapa = await env.DB.prepare(
        'SELECT id, slug, titulo, descripcion, lugar, fecha_captura, archivo_nombre, archivo_tamano, formato, minzoom, maxzoom, bounds_json, center_json, estado, creado_por, creado_en, actualizado_en, subido_en FROM ortomosaicos WHERE id = ?',
      ).bind(id).first<MapaRow>();
    } catch {
      mapa = null;
    }
    if (!mapa) return page('Mapa no encontrado', cardError('Ese mapa no existe o ya no está disponible.'), 404, CSS_PANEL + MAPAS_ADMIN_CSS, { token: env.ADMIN_TOKEN, section: 'mapas' });
  }

  const base = '/admin/mapas';
  const val = (key: keyof MapaRow) => esc(mapa ? mapa[key] ?? '' : '');
  const uploadBlock = mapa && !mapa.archivo_nombre
    ? '<section class="card"><div class="sec"><div class="h"><h2>Subir el archivo</h2><span class="pill">.mbtiles</span></div></div>' +
      '<p class="hint">Puede agregar todos los mapas que necesite. El límite actual es ' + esc(formatBytes(maxBytes)) + ' por archivo; cada ortomosaico se guarda por separado en el VPS.</p>' +
      '<form id="mapa-upload-form"><label for="mapa-file">Archivo MBTiles</label>' +
      '<input id="mapa-file" type="file" accept=".mbtiles,application/vnd.sqlite3,application/octet-stream" required>' +
      '<progress id="mapa-progress" max="100" value="0" hidden></progress>' +
      '<p id="mapa-upload-status" class="hint" role="status" aria-live="polite"></p>' +
      '<button class="btn" id="mapa-upload-button" type="submit">Subir y validar MBTiles</button></form>' +
      '<noscript><p class="hint">Para mostrar el progreso de la carga, habilite JavaScript y vuelva a cargar esta página.</p></noscript></section>'
    : mapa
      ? '<section class="card okline"><div class="sec"><div class="h"><h2>Archivo guardado</h2><span class="pill">' + esc(String(mapa.formato || '').toUpperCase()) + '</span></div></div>' +
        '<p><strong>' + esc(mapa.archivo_nombre) + '</strong> · ' + esc(formatBytes(mapa.archivo_tamano)) + '</p>' +
        '<p class="hint">Zoom ' + esc(mapa.minzoom ?? '—') + '–' + esc(mapa.maxzoom ?? '—') + '. El archivo se conserva incluso si archiva el mapa.</p></section>'
      : '';

  let publishControls = '';
  if (mapa?.archivo_nombre) {
    const actionState = mapa.estado === 'publicado' ? 'borrador' : 'publicado';
    const actionLabel = mapa.estado === 'publicado' ? 'Ocultar del sitio' : 'Publicar mapa';
    publishControls = '<section class="card"><div class="sec"><h2>Visibilidad</h2></div>' +
      '<p class="hint">' + (mapa.estado === 'publicado'
        ? 'Este mapa aparece en la galería pública.'
        : 'El mapa solo aparecerá en la galería después de publicarlo.') + '</p>' +
      '<form method="POST" action="' + base + '/' + esc(mapa.id) + '/estado" data-busy="Actualizando...">' +
      '<input type="hidden" name="estado" value="' + actionState + '">' +
      '<button class="btn" type="submit">' + actionLabel + '</button></form>' +
      (mapa.estado !== 'archivado'
        ? '<form class="mapa-archive" method="POST" action="' + base + '/' + esc(mapa.id) + '/estado" data-busy="Archivando..." onsubmit="return confirm(\'¿Ocultar y archivar este mapa? El archivo se conserva.\')">' +
          '<input type="hidden" name="estado" value="archivado"><button class="btn ghost" type="submit">Archivar mapa</button></form>'
        : '<p class="hint">Archivado: no aparece en público; el MBTiles se conserva hasta que lo elimine permanentemente.</p>' + formularioEliminarMapa(mapa.id, 'mapa-archive')) +
      '</section>';
  }

  const body = '<div class="sec"><h1><span>' + (esNuevo ? 'Agregar ortomosaico' : 'Administrar mapa') + '</span></h1><a class="btn ghost sm" href="/admin/mapas">Volver a mapas</a></div>' +
    (aviso ? '<div class="card okline"><p class="ok" style="margin:0">' + esc(aviso) + '</p></div>' : '') +
    '<p class="lead">Complete los datos del levantamiento. El archivo solo se hace público cuando usted lo publica.</p>' +
    '<form class="card" method="POST" action="' + (esNuevo ? base + '/crear' : base + '/' + esc(mapa!.id) + '/guardar') + '" data-busy="Guardando...">' +
    '<label for="mapa-title">Título</label><input id="mapa-title" name="titulo" required maxlength="120" value="' + val('titulo') + '" placeholder="Ej.: Ortofoto de Pameda, 2026">' +
    '<label for="mapa-description">Descripción</label><textarea id="mapa-description" name="descripcion" required maxlength="2000" rows="4" placeholder="Qué muestra este ortomosaico y para qué se realizó">' + val('descripcion') + '</textarea>' +
    '<label for="mapa-place">Lugar</label><input id="mapa-place" name="lugar" required maxlength="160" value="' + val('lugar') + '" placeholder="Ej.: Pameda, David, Chiriquí">' +
    '<label for="mapa-date">Fecha del levantamiento</label><input id="mapa-date" name="fecha_captura" type="date" required value="' + val('fecha_captura') + '">' +
    '<p style="margin-top:16px"><button class="btn" type="submit">' + (esNuevo ? 'Crear borrador' : 'Guardar datos') + '</button></p></form>' +
    uploadBlock + publishControls +
    (mapa ? '<p class="hint">Enlace: <span class="code">/mapas/' + esc(mapa.slug) + '/</span></p>' : '') +
    (mapa && !mapa.archivo_nombre ? uploadScript(mapa.id, maxBytes) : '');

  return page(esNuevo ? 'Agregar ortomosaico' : 'Administrar mapa', body, 200, CSS_PANEL + MAPAS_ADMIN_CSS, { token: env.ADMIN_TOKEN, section: 'mapas' });
}

export async function handleAdminMapaCrear(request: Request, env: AdminEnv, email: string): Promise<Response> {
  const back = '/admin/mapas/nuevo';
  try {
    const form = await request.formData();
    const titulo = cleanMapText(form.get('titulo'), 120);
    const descripcion = cleanMapText(form.get('descripcion'), 2000);
    const lugar = cleanMapText(form.get('lugar'), 160);
    const fecha = validCaptureDate(form.get('fecha_captura'));
    if (titulo.length < 3 || descripcion.length < 5 || lugar.length < 2 || !fecha) {
      return redirect(back + '?aviso=' + encodeURIComponent('Revise el título, la descripción, el lugar y la fecha del levantamiento.'));
    }

    await ensureMapasTable(env.DB);
    const id = crypto.randomUUID();
    const baseSlug = slugFromTitle(titulo);
    let slug = baseSlug;
    let suffix = 2;
    while (await env.DB.prepare('SELECT id FROM ortomosaicos WHERE slug = ?').bind(slug).first()) {
      slug = `${baseSlug}-${suffix++}`;
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO ortomosaicos (id, slug, titulo, descripcion, lugar, fecha_captura, estado, creado_por, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, 'borrador', ?, ?, ?)",
    ).bind(id, slug, titulo, descripcion, lugar, fecha, email.trim().toLowerCase(), now, now).run();
    return redirect(`/admin/mapas/${encodeURIComponent(id)}?aviso=${encodeURIComponent('Borrador creado. Ahora suba el MBTiles.')}`);
  } catch {
    return redirect(back + '?aviso=' + encodeURIComponent('No se pudo crear el borrador. Vuelva a intentarlo.'));
  }
}

export async function handleAdminMapaGuardar(request: Request, env: AdminEnv, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return redirect(avisoUrl('El identificador del mapa no es válido.'));
  const back = `/admin/mapas/${encodeURIComponent(id)}`;
  try {
    const form = await request.formData();
    const titulo = cleanMapText(form.get('titulo'), 120);
    const descripcion = cleanMapText(form.get('descripcion'), 2000);
    const lugar = cleanMapText(form.get('lugar'), 160);
    const fecha = validCaptureDate(form.get('fecha_captura'));
    if (titulo.length < 3 || descripcion.length < 5 || lugar.length < 2 || !fecha) {
      return redirect(back + '?aviso=' + encodeURIComponent('Revise el título, la descripción, el lugar y la fecha del levantamiento.'));
    }
    await ensureMapasTable(env.DB);
    const result = await env.DB.prepare(
      'UPDATE ortomosaicos SET titulo = ?, descripcion = ?, lugar = ?, fecha_captura = ?, actualizado_en = ? WHERE id = ?',
    ).bind(titulo, descripcion, lugar, fecha, new Date().toISOString(), id).run();
    const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
    if (changes < 1) return redirect(`/admin/mapas?aviso=${encodeURIComponent('Ese mapa ya no está disponible.')}`);
    return redirect(back + '?aviso=' + encodeURIComponent('Datos guardados.'));
  } catch {
    return redirect(back + '?aviso=' + encodeURIComponent('No se pudieron guardar los datos. Vuelva a intentarlo.'));
  }
}

export async function handleAdminMapaEstado(request: Request, env: AdminEnv, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return redirect(avisoUrl('El identificador del mapa no es válido.'));
  const back = `/admin/mapas/${encodeURIComponent(id)}`;
  try {
    const form = await request.formData();
    const estado = String(form.get('estado') || '');
    if (!['borrador', 'publicado', 'archivado'].includes(estado)) {
      return redirect(back + '?aviso=' + encodeURIComponent('El estado solicitado no es válido.'));
    }
    await ensureMapasTable(env.DB);
    const mapa = await env.DB.prepare(
      'SELECT id, slug, archivo_nombre, estado FROM ortomosaicos WHERE id = ?',
    ).bind(id).first<{ id: string; slug: string; archivo_nombre: string | null; estado: string }>();
    if (!mapa) return redirect(`/admin/mapas?aviso=${encodeURIComponent('Ese mapa ya no está disponible.')}`);
    if (estado === 'publicado' && !mapa.archivo_nombre) {
      return redirect(back + '?aviso=' + encodeURIComponent('Primero suba y valide el archivo MBTiles.'));
    }

    if (estado === 'publicado') {
      const response = await backendRequest(env, `/maps/${encodeURIComponent(id)}/activate`, { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as any;
        return redirect(back + '?aviso=' + encodeURIComponent(String(data?.error?.message || 'El servidor de mapas no está listo para publicar.')));
      }
    } else if (mapa.archivo_nombre) {
      const response = await backendRequest(env, `/maps/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as any;
        return redirect(back + '?aviso=' + encodeURIComponent(String(data?.error?.message || 'No se pudo retirar el mapa del servidor de teselas.')));
      }
    }

    await env.DB.prepare('UPDATE ortomosaicos SET estado = ?, actualizado_en = ? WHERE id = ?')
      .bind(estado, new Date().toISOString(), id).run();
    const message = estado === 'publicado' ? 'Mapa publicado en la galería.' : estado === 'archivado' ? 'Mapa archivado; el archivo se conserva.' : 'Mapa oculto del sitio.';
    return redirect(back + '?aviso=' + encodeURIComponent(message));
  } catch (error) {
    const message = error instanceof Error && error.message === 'backend_not_configured'
      ? 'La conexión con el servidor de mapas todavía no está configurada.'
      : 'No se pudo cambiar la visibilidad del mapa. Vuelva a intentarlo.';
    return redirect(back + '?aviso=' + encodeURIComponent(message));
  }
}

export async function handleAdminMapaEliminar(_request: Request, env: AdminEnv, id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return redirect(avisoUrl('El identificador del mapa no es válido.'));

  let backendDeleted = false;
  try {
    await ensureMapasTable(env.DB);
    const mapa = await env.DB.prepare('SELECT estado FROM ortomosaicos WHERE id = ?').bind(id).first<{ estado: string }>();
    if (!mapa) return redirect(avisoUrl('Ese mapa ya no está disponible.'));
    if (mapa.estado !== 'archivado') {
      return redirect(avisoUrl('Solo se pueden eliminar mapas archivados.'));
    }

    const response = await backendRequest(env, `/maps/${encodeURIComponent(id)}/file`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as any;
      const message = String(data?.error?.message || 'No se pudo eliminar el MBTiles del servidor.');
      return redirect(avisoUrl(message));
    }
    backendDeleted = true;

    const result = await env.DB.prepare("DELETE FROM ortomosaicos WHERE id = ? AND estado = 'archivado'").bind(id).run();
    const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
    if (changes < 1) {
      return redirect(avisoUrl('El MBTiles se eliminó, pero la ficha cambió. Actualice la lista y revise el mapa.'));
    }
    return redirect(avisoUrl('El mapa y su archivo MBTiles se eliminaron permanentemente.'));
  } catch (error) {
    const message = error instanceof Error && error.message === 'backend_not_configured'
      ? 'La conexión con el servidor de mapas todavía no está configurada.'
      : backendDeleted
        ? 'El MBTiles se eliminó, pero no se pudo borrar la ficha. Vuelva a intentarlo.'
        : 'No se pudo eliminar el mapa. Vuelva a intentarlo.';
    return redirect(avisoUrl(message));
  }
}

function uploadScript(id: string, maxBytes: number): string {
  const safeId = esc(id);
  const maxLabel = esc(formatBytes(maxBytes));
  return '<script>(function(){var form=document.getElementById("mapa-upload-form");if(!form)return;' +
    'var input=document.getElementById("mapa-file"),progress=document.getElementById("mapa-progress"),status=document.getElementById("mapa-upload-status"),button=document.getElementById("mapa-upload-button");' +
    'form.addEventListener("submit",function(event){event.preventDefault();var file=input&&input.files&&input.files[0];if(!file){status.textContent="Seleccione un archivo .mbtiles.";return;}' +
    'if(!file.name.toLowerCase().endsWith(".mbtiles")){status.textContent="El archivo debe terminar en .mbtiles.";return;}' +
    'if(file.size>' + maxBytes + '){status.textContent="El archivo supera el límite actual de ' + maxLabel + '.";return;}' +
    'button.disabled=true;progress.hidden=false;progress.value=0;status.textContent="Subiendo y revisando la base SQLite…";' +
    'var xhr=new XMLHttpRequest();xhr.open("PUT","/api/admin/mapas/' + safeId + '/archivo");xhr.setRequestHeader("Content-Type","application/vnd.sqlite3");xhr.setRequestHeader("X-File-Name",encodeURIComponent(file.name));xhr.timeout=600000;' +
    'xhr.upload.addEventListener("progress",function(e){if(e.lengthComputable){progress.value=Math.round(e.loaded/e.total*100);status.textContent="Subiendo: "+progress.value+"%";}});' +
    'xhr.addEventListener("load",function(){var data={};try{data=JSON.parse(xhr.responseText||"{}");}catch(e){}if(xhr.status>=200&&xhr.status<300){status.textContent="MBTiles validado y guardado. Actualizando…";window.setTimeout(function(){window.location.reload();},500);return;}' +
    'status.textContent=(data.error&&data.error.message)||"No se pudo subir el archivo ("+xhr.status+").";button.disabled=false;});' +
    'xhr.addEventListener("error",function(){status.textContent="Falló la conexión durante la carga. Compruebe la conexión y vuelva a intentar.";button.disabled=false;});' +
    'xhr.addEventListener("timeout",function(){status.textContent="La carga tardó demasiado. Si el archivo quedó guardado, actualice la página antes de volver a intentarlo.";button.disabled=false;});xhr.send(file);});})();</script>';
}

const MAPAS_ADMIN_CSS = [
  '.mapas-nav{flex-wrap:wrap;margin-top:10px}',
  '.mapa-admin-resumen{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}',
  '.mapa-admin-resumen>div{display:grid;gap:3px;padding:14px;border:1px solid var(--line);border-radius:12px;background:#fff}',
  '.mapa-admin-resumen strong{font-size:1.3rem;color:var(--brand)}.mapa-admin-resumen span,.mapa-meta{font-size:.82rem;color:#667085}',
  '.mapa-admin-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
  '.mapa-admin-card{min-width:0}.mapa-admin-card h2{margin:12px 0 4px;font-size:1.12rem}',
  '.mapa-admin-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}',
  '.mapa-admin-desc{margin:9px 0;color:#344054;overflow-wrap:anywhere}',
  '.mapa-admin-actions{margin-top:14px;flex-wrap:wrap}',
  '#mapa-file{min-height:44px;font-size:16px;cursor:pointer}',
  '.mapa-estado{display:inline-flex;align-items:center;padding:5px 9px;border-radius:999px;font-size:.76rem;font-weight:700}',
  '.mapa-publicado{background:#ECFDF3;color:#067647}.mapa-borrador{background:#EFF4FF;color:#3538CD}.mapa-archivado{background:#F2F4F7;color:#475467}',
  '.mapa-archive{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}',
  '#mapa-progress{display:block;width:100%;height:14px;margin:12px 0;accent-color:var(--brand)}',
  '#mapa-upload-status:empty{display:none}',
  '@media(max-width:700px){.mapa-admin-grid{grid-template-columns:1fr}.mapa-admin-resumen{gap:6px}.mapa-admin-resumen>div{padding:10px}.mapa-admin-resumen span{font-size:.75rem}.mapa-nav .btn{flex:1;justify-content:center}}',
].join('\n');
