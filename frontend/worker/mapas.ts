export type MapasEnv = {
  DB: any;
  MAPAS_BACKEND_URL?: string;
  MAPAS_BACKEND_SECRET?: string;
  MAPAS_TILES_URL?: string;
  MAPAS_MAX_UPLOAD_BYTES?: string;
  ADMIN_EMAILS?: string;
};

export type MapaRow = {
  id: string;
  slug: string;
  titulo: string;
  descripcion: string;
  lugar: string;
  fecha_captura: string;
  archivo_nombre: string | null;
  archivo_tamano: number;
  formato: string | null;
  minzoom: number | null;
  maxzoom: number | null;
  bounds_json: string | null;
  center_json: string | null;
  estado: 'borrador' | 'publicado' | 'archivado';
  creado_por: string;
  creado_en: string;
  actualizado_en: string;
  subido_en: string | null;
};

export const MAX_MAPA_BYTES = 90_000_000;

let mapasTablaLista = false;

export async function ensureMapasTable(db: any): Promise<void> {
  if (mapasTablaLista) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ortomosaicos (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      titulo TEXT NOT NULL,
      descripcion TEXT NOT NULL DEFAULT '',
      lugar TEXT NOT NULL,
      fecha_captura TEXT NOT NULL,
      archivo_nombre TEXT,
      archivo_tamano INTEGER NOT NULL DEFAULT 0,
      formato TEXT,
      minzoom INTEGER,
      maxzoom INTEGER,
      bounds_json TEXT,
      center_json TEXT,
      estado TEXT NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'publicado', 'archivado')),
      creado_por TEXT NOT NULL,
      creado_en TEXT NOT NULL,
      actualizado_en TEXT NOT NULL,
      subido_en TEXT
    )`,
  ).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_ortomosaicos_estado_fecha ON ortomosaicos (estado, fecha_captura DESC, actualizado_en DESC)',
  ).run();
  mapasTablaLista = true;
}

export function cleanMapText(value: unknown, max: number): string {
  return Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, max).join('');
}

export function validCaptureDate(value: unknown): string | null {
  const date = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

export function slugFromTitle(value: string): string {
  const slug = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return slug || 'mapa';
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function tileJsonUrl(env: MapasEnv, id: string): string {
  const base = String(env.MAPAS_TILES_URL || 'https://tiles.ricardosanjur.com').replace(/\/$/, '');
  return `${base}/data/${encodeURIComponent(id)}.json`;
}

export function publicMap(row: MapaRow, env: MapasEnv) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.titulo,
    description: row.descripcion,
    place: row.lugar,
    capture_date: row.fecha_captura,
    format: row.formato,
    min_zoom: row.minzoom,
    max_zoom: row.maxzoom,
    bounds: parseJson(row.bounds_json),
    center: parseJson(row.center_json),
    tilejson_url: tileJsonUrl(env, row.id),
  };
}

function jsonResponse(value: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });
}

export async function getPublishedMapa(env: MapasEnv, slug: string): Promise<MapaRow | null> {
  await ensureMapasTable(env.DB);
  return env.DB.prepare(
    "SELECT id, slug, titulo, descripcion, lugar, fecha_captura, archivo_nombre, archivo_tamano, formato, minzoom, maxzoom, bounds_json, center_json, estado, creado_por, creado_en, actualizado_en, subido_en FROM ortomosaicos WHERE slug = ? AND estado = 'publicado' AND archivo_nombre IS NOT NULL",
  ).bind(slug).first<MapaRow>();
}

export async function backendRequest(
  env: MapasEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const secret = String(env.MAPAS_BACKEND_SECRET || '');
  if (new TextEncoder().encode(secret).length < 32) throw new Error('backend_not_configured');
  const base = String(env.MAPAS_BACKEND_URL || 'https://tiles.ricardosanjur.com/internal').replace(/\/$/, '');
  const headers = new Headers(init.headers || {});
  headers.set('authorization', `Bearer ${secret}`);
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers,
    redirect: 'manual',
    signal: init.signal || AbortSignal.timeout(120_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error('backend_redirect_rejected');
  }
  return response;
}

function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !!origin && origin === new URL(request.url).origin;
}

function emailAllowed(env: MapasEnv, email: string): boolean {
  const allowed = String(env.ADMIN_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

function parseMapId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeUploadName(value: string): string | null {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  const base = decoded.split(/[\\/]/).pop() || '';
  if (!/\.mbtiles$/i.test(base)) return null;
  return base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[. ]+/, '').slice(-120) || null;
}

export async function handleMapasApi(request: Request, env: MapasEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (request.method !== 'GET') return null;

  if (path === '/api/mapas') {
    try {
      await ensureMapasTable(env.DB);
      const limitRaw = Number(url.searchParams.get('limit') || 24);
      const offsetRaw = Number(url.searchParams.get('offset') || 0);
      const limit = Number.isInteger(limitRaw) ? Math.min(60, Math.max(1, limitRaw)) : 24;
      const offset = Number.isInteger(offsetRaw) ? Math.min(100_000, Math.max(0, offsetRaw)) : 0;
      const totalRow = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM ortomosaicos WHERE estado = 'publicado' AND archivo_nombre IS NOT NULL",
      ).first<{ total: number }>();
      const rows = await env.DB.prepare(
        "SELECT id, slug, titulo, descripcion, lugar, fecha_captura, archivo_nombre, archivo_tamano, formato, minzoom, maxzoom, bounds_json, center_json, estado, creado_por, creado_en, actualizado_en, subido_en FROM ortomosaicos WHERE estado = 'publicado' AND archivo_nombre IS NOT NULL ORDER BY fecha_captura DESC, actualizado_en DESC LIMIT ? OFFSET ?",
      ).bind(limit, offset).all<MapaRow>();
      return jsonResponse({
        data: (rows.results || []).map((row: MapaRow) => publicMap(row, env)),
        meta: { limit, offset, total: Number(totalRow?.total || 0), has_more: offset + (rows.results || []).length < Number(totalRow?.total || 0) },
      }, 200, 'public, max-age=30, s-maxage=60');
    } catch {
      return jsonResponse({ error: { code: 'MAPAS_UNAVAILABLE', message: 'La galería no está disponible ahora.' } }, 503);
    }
  }

  const m = path.match(/^\/api\/mapas\/([a-z0-9-]{3,80})$/);
  if (m) {
    try {
      const row = await getPublishedMapa(env, m[1]);
      if (!row) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Mapa no encontrado.' } }, 404);
      return jsonResponse({ data: publicMap(row, env) }, 200, 'public, max-age=30, s-maxage=60');
    } catch {
      return jsonResponse({ error: { code: 'MAPAS_UNAVAILABLE', message: 'El mapa no está disponible ahora.' } }, 503);
    }
  }
  return null;
}

export async function handleAdminMapaUploadApi(
  request: Request,
  env: MapasEnv,
  email: string | null,
): Promise<Response> {
  if (!email || !emailAllowed(env, email)) {
    return jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'Entre con una cuenta autorizada.' } }, 401);
  }
  if (!allowedOrigin(request)) {
    return jsonResponse({ error: { code: 'INVALID_ORIGIN', message: 'Solicitud no autorizada.' } }, 403);
  }

  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/admin\/mapas\/([0-9a-f-]{36})\/archivo$/);
  if (!match || !parseMapId(match[1])) {
    return jsonResponse({ error: { code: 'INVALID_ID', message: 'Identificador de mapa no válido.' } }, 400);
  }
  const id = match[1];
  const name = safeUploadName(request.headers.get('x-file-name') || '');
  if (!name) return jsonResponse({ error: { code: 'INVALID_FILE', message: 'Seleccione un archivo .mbtiles.' } }, 400);
  const length = Number(request.headers.get('content-length') || 0);
  const max = Number(env.MAPAS_MAX_UPLOAD_BYTES || MAX_MAPA_BYTES);
  if (Number.isFinite(length) && length > max) {
    return jsonResponse({ error: { code: 'FILE_TOO_LARGE', message: 'El archivo supera el límite actual de 90 MB.' } }, 413);
  }
  if (!request.body) return jsonResponse({ error: { code: 'EMPTY_FILE', message: 'No llegó el archivo.' } }, 400);

  try {
    await ensureMapasTable(env.DB);
    const row = await env.DB.prepare('SELECT id, estado, archivo_nombre FROM ortomosaicos WHERE id = ?').bind(id).first<MapaRow>();
    if (!row || row.estado === 'archivado') {
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Ese borrador no está disponible.' } }, 404);
    }
    if (row.archivo_nombre) {
      return jsonResponse({ error: { code: 'FILE_EXISTS', message: 'Este mapa ya tiene un archivo. Cree otro mapa para cargar una versión nueva.' } }, 409);
    }

    const headers = new Headers({ 'content-type': 'application/vnd.sqlite3', 'x-file-name': name });
    const upstream = await backendRequest(env, `/maps/${encodeURIComponent(id)}/file`, {
      method: 'PUT',
      headers,
      body: request.body,
      signal: AbortSignal.timeout(600_000),
    });
    const body = await upstream.json().catch(() => null) as any;
    if (!upstream.ok || !body || body.ok !== true) {
      const status = [400, 409, 413, 503].includes(upstream.status) ? upstream.status : 502;
      const message = String(body?.error?.message || 'No se pudo validar ni guardar el MBTiles.');
      return jsonResponse({ error: { code: String(body?.error?.code || 'UPLOAD_FAILED'), message } }, status);
    }

    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      "UPDATE ortomosaicos SET archivo_nombre = ?, archivo_tamano = ?, formato = ?, minzoom = ?, maxzoom = ?, bounds_json = ?, center_json = ?, subido_en = ?, actualizado_en = ? WHERE id = ? AND estado != 'archivado' AND archivo_nombre IS NULL",
    ).bind(
      name,
      Number(body.size_bytes) || 0,
      String(body.format || ''),
      Number.isInteger(body.minzoom) ? body.minzoom : null,
      Number.isInteger(body.maxzoom) ? body.maxzoom : null,
      body.bounds ? JSON.stringify(body.bounds) : null,
      body.center ? JSON.stringify(body.center) : null,
      now,
      now,
      id,
    ).run();
    const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
    if (changes < 1) {
      return jsonResponse({ error: { code: 'MAP_CHANGED', message: 'El mapa cambió mientras se subía. Actualice la página y revise su estado.' } }, 409);
    }
    return jsonResponse({ ok: true, file_name: name, size_bytes: Number(body.size_bytes) || 0, format: body.format }, 201);
  } catch (error) {
    const message = error instanceof Error && error.message === 'backend_not_configured'
      ? 'La carga de mapas todavía no está configurada.'
      : 'No se pudo conectar con el servicio de mapas. Intente otra vez.';
    return jsonResponse({ error: { code: 'MAPAS_BACKEND_UNAVAILABLE', message } }, 503);
  }
}
