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
const MAX_CAD_REQUEST_BYTES = MAX_MAPA_BYTES + 500_000;
const CAD_PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const CAD_LAYER_ID_RE = /^[0-9a-f]{32}$/;

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
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS cad_public_rate_limits (
      ip_hash TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      request_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_cad_public_rate_limits_updated ON cad_public_rate_limits (updated_at)',
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

function cadProjectId(value: string | null): string | null {
  const projectId = String(value || '').trim().toLowerCase();
  return CAD_PROJECT_ID_RE.test(projectId) ? projectId : null;
}

function cadProxyResponse(response: Response, cache = 'private, no-store'): Response {
  const headers = new Headers();
  for (const name of [
    'content-type',
    'content-disposition',
    'content-length',
    'last-modified',
    'etag',
    'x-cad-layer-id',
    'x-cad-feature-count',
    'x-cad-original-name',
    'x-cad-layer-color',
    'x-cad-target-crs',
    'x-cad-export-bytes',
  ]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', cache);
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cadError(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status, 'no-store');
}

const PUBLIC_CAD_MAX_FILE_BYTES = 25_000_000;
const PUBLIC_CAD_MAX_BODY_BYTES = PUBLIC_CAD_MAX_FILE_BYTES + 1_000_000;
const PUBLIC_CAD_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_CAD_REQUEST_LIMIT = 5;
let lastCadRateLimitCleanup = 0;

function limitCadRequestBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
): ReadableStream<Uint8Array> {
  let totalBytes = 0;
  let stopped = false;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stopped) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          stopped = true;
          controller.close();
          return;
        }
        if (value.byteLength > maxBytes - totalBytes) {
          onLimit();
          stopped = true;
          controller.close();
          void reader.cancel('CAD_REQUEST_BODY_TOO_LARGE').catch(() => undefined);
          return;
        }
        totalBytes += value.byteLength;
        controller.enqueue(value);
      } catch (error) {
        stopped = true;
        controller.error(error);
      }
    },
    cancel(reason) {
      stopped = true;
      return reader.cancel(reason);
    },
  });
}

async function publicCadIpHash(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`public-cad:${ip}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function takePublicCadSlot(
  request: Request,
  env: MapasEnv,
): Promise<{ count: number; resetAt: number } | Response> {
  const ip = String(request.headers.get('cf-connecting-ip') || '').trim();
  const secret = String(env.MAPAS_BACKEND_SECRET || '');
  if (!/^[0-9a-fA-F:.]{2,64}$/.test(ip)) {
    return cadError('CLIENT_IP_UNAVAILABLE', 'No se pudo validar la conexión para esta conversión.', 503);
  }
  if (new TextEncoder().encode(secret).length < 32 || !env.DB) {
    return cadError('CAD_CONVERTER_UNAVAILABLE', 'El servicio de conversión no está configurado.', 503);
  }

  const now = Date.now();
  const windowStart = Math.floor(now / PUBLIC_CAD_WINDOW_MS) * PUBLIC_CAD_WINDOW_MS;
  const resetAt = windowStart + PUBLIC_CAD_WINDOW_MS;
  try {
    await ensureMapasTable(env.DB);
    const ipHash = await publicCadIpHash(ip, secret);
    const row = await env.DB.prepare(
      `INSERT INTO cad_public_rate_limits (ip_hash, window_start, request_count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(ip_hash) DO UPDATE SET
         request_count = CASE
           WHEN cad_public_rate_limits.window_start = excluded.window_start
           THEN cad_public_rate_limits.request_count + 1
           ELSE 1
         END,
         window_start = excluded.window_start,
         updated_at = excluded.updated_at
       RETURNING request_count`,
    ).bind(ipHash, windowStart, now).first();
    const count = Number(row?.request_count);
    if (!Number.isInteger(count) || count < 1) throw new Error('cad_rate_limit_counter_unavailable');

    if (now - lastCadRateLimitCleanup > 6 * 60 * 60 * 1000) {
      lastCadRateLimitCleanup = now;
      try {
        await env.DB.prepare('DELETE FROM cad_public_rate_limits WHERE updated_at < ?')
          .bind(now - 30 * 24 * 60 * 60 * 1000).run();
      } catch (error) {
        console.error('[public-cad] rate-limit cleanup failed', error instanceof Error ? error.name : 'UnknownError');
      }
    }
    return { count, resetAt };
  } catch (error) {
    console.error('[public-cad] rate-limit check failed', error instanceof Error ? error.name : 'UnknownError');
    return cadError('CAD_CONVERTER_UNAVAILABLE', 'No se pudo validar el límite de conversiones. Intente otra vez.', 503);
  }
}

function withPublicCadRateHeaders(response: Response, count: number, resetAt: number): Response {
  const headers = new Headers(response.headers);
  headers.set('x-ratelimit-limit', String(PUBLIC_CAD_REQUEST_LIMIT));
  headers.set('x-ratelimit-remaining', String(Math.max(0, PUBLIC_CAD_REQUEST_LIMIT - count)));
  headers.set('x-ratelimit-reset', String(Math.ceil(resetAt / 1000)));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function handlePublicCadApi(request: Request, env: MapasEnv): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname === '/api/mapas/cad/overlay'
    ? { backendPath: '/cad/public/overlay', accept: 'application/geo+json' }
    : url.pathname === '/api/mapas/cad/convert-media'
      ? { backendPath: '/cad/public/convert-media', accept: '*/*' }
      : null;
  if (!route) return cadError('NOT_FOUND', 'Ruta de conversión no encontrada.', 404);
  if (request.method !== 'POST') return cadError('METHOD_NOT_ALLOWED', 'Método no permitido.', 405);
  if (!allowedOrigin(request)) return cadError('ORIGIN_REJECTED', 'Origen de solicitud no permitido.', 403);
  if (!request.body) return cadError('EMPTY_BODY', 'No se recibió el archivo.', 400);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return cadError('INVALID_CONTENT_TYPE', 'Envíe el archivo como formulario multipart.', 415);
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 1) return cadError('INVALID_CONTENT_LENGTH', 'El tamaño del archivo no es válido.', 400);
    if (length > PUBLIC_CAD_MAX_BODY_BYTES) return cadError('PUBLIC_UPLOAD_TOO_LARGE', 'El límite de carga pública es 25 MB.', 413);
  }

  const slot = await takePublicCadSlot(request, env);
  if (slot instanceof Response) return slot;
  if (slot.count > PUBLIC_CAD_REQUEST_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((slot.resetAt - Date.now()) / 1000));
    return new Response(JSON.stringify({
      error: { code: 'PUBLIC_CAD_RATE_LIMITED', message: 'Límite temporal alcanzado. Intente de nuevo en unos minutos.' },
    }), {
      status: 429,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(retryAfter),
        'x-ratelimit-limit': String(PUBLIC_CAD_REQUEST_LIMIT),
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.ceil(slot.resetAt / 1000)),
      },
    });
  }

  let bodyTooLarge = false;
  const limitedBody = limitCadRequestBody(request.body, PUBLIC_CAD_MAX_BODY_BYTES, () => {
    bodyTooLarge = true;
  });
  try {
    const response = await backendRequest(env, route.backendPath, {
      method: 'POST',
      headers: {
        accept: route.accept,
        'content-type': contentType,
      },
      body: limitedBody,
      signal: AbortSignal.timeout(300_000),
    });
    if (bodyTooLarge) {
      await response.body?.cancel();
      return withPublicCadRateHeaders(
        cadError('PUBLIC_UPLOAD_TOO_LARGE', 'El límite de carga pública es 25 MB.', 413),
        slot.count,
        slot.resetAt,
      );
    }
    return withPublicCadRateHeaders(cadProxyResponse(response, 'no-store'), slot.count, slot.resetAt);
  } catch (error) {
    if (bodyTooLarge) {
      return withPublicCadRateHeaders(
        cadError('PUBLIC_UPLOAD_TOO_LARGE', 'El límite de carga pública es 25 MB.', 413),
        slot.count,
        slot.resetAt,
      );
    }
    const message = error instanceof Error && error.message === 'backend_not_configured'
      ? 'El servicio de conversión todavía no está configurado.'
      : 'No se pudo conectar con el servicio de conversión. Intente otra vez.';
    return cadError('CAD_CONVERTER_UNAVAILABLE', message, 503);
  }
}

async function cadProjectExists(env: MapasEnv, projectId: string): Promise<boolean> {
  return Boolean(await getPublishedMapa(env, projectId));
}

export async function handleAdminCadApi(
  request: Request,
  env: MapasEnv,
  email: string | null,
): Promise<Response> {
  if (!email || !emailAllowed(env, email)) {
    return cadError('UNAUTHORIZED', 'Inicie sesión con una cuenta autorizada para usar el conversor.', 401);
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const basePath = '/api/admin/mapas/cad';

  if (method !== 'GET' && !allowedOrigin(request)) {
    return cadError('ORIGIN_REJECTED', 'Origen de solicitud no permitido.', 403);
  }

  if (path === `${basePath}/status`) {
    if (method !== 'GET') return cadError('METHOD_NOT_ALLOWED', 'Método no permitido.', 405);
    try {
      const response = await backendRequest(env, '/cad/health', {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return cadError('CAD_CONVERTER_UNAVAILABLE', 'El servicio de conversión no está disponible.', 503);
      return jsonResponse({ ok: true }, 200, 'private, no-store');
    } catch {
      return cadError('CAD_CONVERTER_UNAVAILABLE', 'El servicio de conversión no está disponible.', 503);
    }
  }

  if (path === `${basePath}/layers`) {
    if (method !== 'GET') return cadError('METHOD_NOT_ALLOWED', 'Método no permitido.', 405);
    const projectId = cadProjectId(url.searchParams.get('project_id'));
    if (!projectId) return cadError('INVALID_PROJECT', 'Seleccione un proyecto publicado.', 400);
    try {
      if (!await cadProjectExists(env, projectId)) return cadError('PROJECT_NOT_FOUND', 'El proyecto no está publicado.', 404);
      const response = await backendRequest(env, `/cad/saved-layers/${encodeURIComponent(projectId)}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-map-project-id': projectId, 'x-admin-email': email },
        signal: AbortSignal.timeout(30_000),
      });
      return cadProxyResponse(response);
    } catch {
      return cadError('CAD_CONVERTER_UNAVAILABLE', 'No se pudo cargar la biblioteca de capas.', 503);
    }
  }

  const savedLayerMatch = path.match(/^\/api\/admin\/mapas\/cad\/layers\/([a-z0-9][a-z0-9-]{0,62})\/([0-9a-f]{32})$/);
  if (savedLayerMatch) {
    if (method !== 'GET') return cadError('METHOD_NOT_ALLOWED', 'Método no permitido.', 405);
    const projectId = cadProjectId(savedLayerMatch[1]);
    const layerId = savedLayerMatch[2];
    if (!projectId || !CAD_LAYER_ID_RE.test(layerId)) return cadError('INVALID_LAYER', 'La capa indicada no es válida.', 400);
    try {
      if (!await cadProjectExists(env, projectId)) return cadError('PROJECT_NOT_FOUND', 'El proyecto no está publicado.', 404);
      const response = await backendRequest(env, `/cad/saved-layers/${encodeURIComponent(projectId)}/${encodeURIComponent(layerId)}`, {
        method: 'GET',
        headers: { accept: 'application/geo+json', 'x-map-project-id': projectId, 'x-admin-email': email },
        signal: AbortSignal.timeout(120_000),
      });
      return cadProxyResponse(response);
    } catch {
      return cadError('CAD_CONVERTER_UNAVAILABLE', 'No se pudo cargar la capa guardada.', 503);
    }
  }

  if (path === `${basePath}/convert` || path === `${basePath}/convert-media`) {
    if (method !== 'POST') return cadError('METHOD_NOT_ALLOWED', 'Método no permitido.', 405);
    const projectId = cadProjectId(url.searchParams.get('project_id'));
    if (!projectId) return cadError('INVALID_PROJECT', 'Seleccione un proyecto publicado.', 400);
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
      return cadError('INVALID_CONTENT_TYPE', 'La carga debe usar multipart/form-data.', 415);
    }
    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        return cadError('INVALID_LENGTH', 'El tamaño de la carga no es válido.', 400);
      }
      if (contentLength > MAX_CAD_REQUEST_BYTES) {
        return cadError('FILE_TOO_LARGE', 'La carga supera el límite de 90 MB.', 413);
      }
    }
    if (!request.body) return cadError('EMPTY_BODY', 'Seleccione un archivo para convertir.', 400);
    let bodyTooLarge = false;
    const limitedBody = limitCadRequestBody(request.body, MAX_CAD_REQUEST_BYTES, () => {
      bodyTooLarge = true;
    });
    try {
      if (!await cadProjectExists(env, projectId)) return cadError('PROJECT_NOT_FOUND', 'El proyecto no está publicado.', 404);
      const backendPath = path.endsWith('/convert-media') ? '/cad/convert-media' : '/cad/convert';
      const accept = backendPath.endsWith('convert') ? 'application/geo+json' : '*/*';
      const response = await backendRequest(env, backendPath, {
        method: 'POST',
        headers: {
          accept,
          'content-type': contentType,
          'x-map-project-id': projectId,
          'x-admin-email': email,
        },
        body: limitedBody,
        signal: AbortSignal.timeout(300_000),
      });
      if (bodyTooLarge) {
        await response.body?.cancel();
        return cadError('FILE_TOO_LARGE', 'La carga supera el límite de 90 MB.', 413);
      }
      return cadProxyResponse(response);
    } catch (error) {
      if (bodyTooLarge) return cadError('FILE_TOO_LARGE', 'La carga supera el límite de 90 MB.', 413);
      const message = error instanceof Error && error.message === 'backend_not_configured'
        ? 'El servicio de conversión todavía no está configurado.'
        : 'No se pudo conectar con el servicio de conversión. Intente otra vez.';
      return cadError('CAD_CONVERTER_UNAVAILABLE', message, 503);
    }
  }

  return cadError('NOT_FOUND', 'Ruta de conversión no encontrada.', 404);
}
