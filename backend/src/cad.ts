const DEFAULT_CONVERTER_URL = 'http://cad-converter-api:8090';
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LAYER_ID_PATTERN = /^[0-9a-f]{32}$/;

type CadRoute = {
  method: string;
  path: string;
  needsProject?: boolean;
  needsLayer?: boolean;
  hasBody?: boolean;
};

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function routeFor(pathname: string, method: string): CadRoute | null {
  if (pathname === '/internal/cad/health' && method === 'GET') {
    return { method, path: '/health' };
  }
  if (pathname === '/internal/cad/convert' && method === 'POST') {
    return { method, path: '/api/convert', hasBody: true, needsProject: true };
  }
  if (pathname === '/internal/cad/convert-media' && method === 'POST') {
    return { method, path: '/api/convert-media', hasBody: true, needsProject: true };
  }
  if (pathname === '/internal/cad/public/overlay' && method === 'POST') {
    return { method, path: '/api/convert', hasBody: true };
  }
  if (pathname === '/internal/cad/public/convert-media' && method === 'POST') {
    return { method, path: '/api/convert-media', hasBody: true };
  }

  const layerMatch = pathname.match(/^\/internal\/cad\/saved-layers\/([a-z0-9-]+)(?:\/([0-9a-f]{32}))?$/);
  if (layerMatch && method === 'GET') {
    const project = layerMatch[1];
    const layer = layerMatch[2];
    if (!PROJECT_ID_PATTERN.test(project) || (layer && !LAYER_ID_PATTERN.test(layer))) return null;
    return {
      method,
      path: `/api/saved-layers/${project}${layer ? `/${layer}` : ''}`,
      needsProject: true,
      needsLayer: Boolean(layer),
    };
  }
  return null;
}

function responseHeaders(source: Headers): Headers {
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
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

export async function handleCadProxy(request: Request): Promise<Response> {
  const sourceUrl = new URL(request.url);
  const route = routeFor(sourceUrl.pathname, request.method.toUpperCase());
  if (!route) return errorResponse('NOT_FOUND', 'Ruta de conversión no encontrada.', 404);

  const projectId = request.headers.get('x-map-project-id') || '';
  if (route.needsProject && !PROJECT_ID_PATTERN.test(projectId)) {
    return errorResponse('INVALID_PROJECT', 'El proyecto indicado no es válido.', 400);
  }
  if (route.needsLayer) {
    const pathLayer = sourceUrl.pathname.split('/').at(-1) || '';
    if (!LAYER_ID_PATTERN.test(pathLayer)) return errorResponse('INVALID_LAYER', 'La capa indicada no es válida.', 400);
  }

  const base = (process.env.CAD_CONVERTER_URL || DEFAULT_CONVERTER_URL).replace(/\/$/, '');
  const target = new URL(`${route.path}${sourceUrl.search}`, `${base}/`);
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'content-length']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (route.needsProject) headers.set('x-map-project-id', projectId);
  const actor = request.headers.get('x-admin-email');
  if (route.needsProject && actor) headers.set('x-admin-email', actor);

  const init: RequestInit & { duplex?: 'half' } = {
    method: route.method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(300_000),
  };
  if (route.hasBody) {
    if (!request.body) return errorResponse('EMPTY_BODY', 'No se recibió el archivo.', 400);
    init.body = request.body;
    init.duplex = 'half';
  }

  try {
    const response = await fetch(target, init);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return errorResponse('REDIRECT_REJECTED', 'El servicio de conversión respondió con una redirección inesperada.', 502);
    }
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders(response.headers),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    console.error('[cad-converter] upstream request failed', name);
    return errorResponse('CAD_CONVERTER_UNAVAILABLE', 'El servicio de conversión no está disponible ahora.', 503);
  }
}
