import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono } from 'hono';
import { handleCadProxy } from './cad.js';
import { inspectMbtiles, MbtilesValidationError, type MbtilesInspection } from './mbtiles.js';

const DATA_DIR = process.env.MAPS_DIR || '/data/maps';
const CONFIG_PATH = process.env.TILESERVER_CONFIG || '/data/config.json';
const TILESERVER_URL = (process.env.TILESERVER_URL || '').replace(/\/$/, '');
const DEFAULT_MAX_UPLOAD_BYTES = 90_000_000;
const CONFIG_ROOT = '/data';
const BACKEND_SECRET = (() => {
  const secretFile = process.env.MAPS_BACKEND_SECRET_FILE || '';
  if (secretFile) {
    try { return readFileSync(secretFile, 'utf8').trim(); } catch { return ''; }
  }
  return process.env.MAPS_BACKEND_SECRET || '';
})();

type TileServerConfig = {
  options?: Record<string, unknown>;
  data?: Record<string, { mbtiles?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

class UploadTooLargeError extends Error {}

class UploadConflictError extends Error {}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function authenticated(request: Request): boolean {
  if (Buffer.byteLength(BACKEND_SECRET) < 32) return false;
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  return constantTimeEqual(header.slice(7), BACKEND_SECRET);
}

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });
}

async function readConfig(): Promise<TileServerConfig> {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as TileServerConfig;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid config');
    if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) parsed.data = {};
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { options: { paths: { root: CONFIG_ROOT } }, data: {} };
    }
    throw new Error('No se pudo leer la configuración del servidor de mapas.');
  }
}

async function writeConfig(config: TileServerConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  const temp = `${CONFIG_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640, flag: 'wx' });
    await rename(temp, CONFIG_PATH);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

let configQueue: Promise<unknown> = Promise.resolve();
function withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = configQueue.then(operation, operation);
  configQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function addToTileConfig(id: string): Promise<void> {
  await withConfigLock(async () => {
    // Recheck under the same lock as permanent deletion so a concurrent activation cannot register a removed file.
    const file = await stat(join(DATA_DIR, `${id}.mbtiles`));
    if (!file.isFile()) throw new Error('El archivo del mapa no es válido.');
    const config = await readConfig();
    config.data![id] = { ...(config.data![id] || {}), mbtiles: join(DATA_DIR, `${id}.mbtiles`) };
    await writeConfig(config);
  });
}

async function removeFromTileConfig(id: string): Promise<void> {
  await withConfigLock(async () => {
    const config = await readConfig();
    delete config.data![id];
    await writeConfig(config);
  });
}

async function waitForTileServer(id: string, expected: 'loaded' | 'removed'): Promise<void> {
  if (!TILESERVER_URL) return;
  const url = `${TILESERVER_URL}/data/${encodeURIComponent(id)}.json`;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      lastStatus = response.status;
      if (expected === 'loaded' && response.ok) {
        await response.body?.cancel();
        return;
      }
      if (expected === 'removed' && response.status === 404) return;
      await response.body?.cancel();
    } catch {
      lastStatus = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`El servidor de teselas no confirmó la actualización (HTTP ${lastStatus || 'sin respuesta'}).`);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function normalizeUploadName(value: string): string {
  const base = value.split(/[\\/]/).pop() || 'mapa.mbtiles';
  return base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[. ]+/, '').slice(-120) || 'mapa.mbtiles';
}

function uploadLimit(): number {
  const configured = Number(process.env.MAPS_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'ortomosaicos-api' }));

app.use('/internal/*', async (c, next) => {
  if (!authenticated(c.req.raw)) return errorResponse('UNAUTHORIZED', 'No autorizado.', 401);
  await next();
});

app.get('/internal/health', (c) => {
  if (Buffer.byteLength(BACKEND_SECRET) < 32) {
    return errorResponse('NOT_CONFIGURED', 'El servicio no está configurado.', 503);
  }
  return c.json({ ok: true, service: 'ortomosaicos-api' }, 200, { 'cache-control': 'no-store' });
});

app.all('/internal/cad/*', (c) => handleCadProxy(c.req.raw));

app.put('/internal/maps/:id/file', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return errorResponse('INVALID_ID', 'Identificador de mapa no válido.', 400);

  if (Buffer.byteLength(BACKEND_SECRET) < 32) return errorResponse('NOT_CONFIGURED', 'El servicio no está configurado.', 503);

  const expectedLength = Number(c.req.header('content-length') || 0);
  if (expectedLength > uploadLimit()) return errorResponse('FILE_TOO_LARGE', 'El archivo supera el límite permitido.', 413);
  if (expectedLength < 0 || !Number.isFinite(expectedLength)) return errorResponse('INVALID_LENGTH', 'El tamaño del archivo no es válido.', 400);

  const body = c.req.raw.body;
  if (!body) return errorResponse('EMPTY_FILE', 'No llegó el archivo.', 400);

  await mkdir(DATA_DIR, { recursive: true });
  const finalPath = join(DATA_DIR, `${id}.mbtiles`);
  const tempPath = join(DATA_DIR, `.${id}.${crypto.randomUUID()}.upload`);
  let bytes = 0;
  const hash = createHash('sha256');
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > uploadLimit()) {
        callback(new UploadTooLargeError());
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  let inspection: MbtilesInspection;
  let digest: string;
  try {
    await pipeline(
      Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>),
      limiter,
      createWriteStream(tempPath, { flags: 'wx', mode: 0o640 }),
    );
    if (bytes === 0) {
      await rm(tempPath, { force: true });
      return errorResponse('EMPTY_FILE', 'No llegó el archivo.', 400);
    }
    if (expectedLength && bytes !== expectedLength) {
      await rm(tempPath, { force: true });
      return errorResponse('LENGTH_MISMATCH', 'La subida quedó incompleta. Vuelva a intentarlo.', 400);
    }
    inspection = inspectMbtiles(tempPath);
    digest = hash.digest('hex');
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof UploadTooLargeError) return errorResponse('FILE_TOO_LARGE', 'El archivo supera el límite permitido.', 413);
    if (error instanceof MbtilesValidationError) return errorResponse('INVALID_MBTILES', error.message, 400);
    console.error('[ortomosaicos-api] upload failed:', error instanceof Error ? error.message : 'unknown');
    return errorResponse('UPLOAD_FAILED', 'No se pudo guardar el archivo. Intente otra vez.', 500);
  }

  try {
    try {
      await link(tempPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await hashFile(finalPath) !== digest) throw new UploadConflictError();
    }
    await rm(tempPath, { force: true });
    const fileStat = await stat(finalPath);
    return c.json({
      ok: true,
      id,
      file_name: normalizeUploadName(c.req.header('x-file-name') || 'mapa.mbtiles'),
      size_bytes: fileStat.size,
      ...inspection,
    }, 201, { 'cache-control': 'no-store' });
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof UploadConflictError) return errorResponse('FILE_ALREADY_EXISTS', 'Este mapa ya tiene un archivo distinto. Cree otro mapa para subir una versión diferente.', 409);
    console.error('[ortomosaicos-api] storage failed:', error instanceof Error ? error.message : 'unknown');
    return errorResponse('STORAGE_FAILED', 'No se pudo guardar el archivo. Intente otra vez.', 500);
  }
});

app.post('/internal/maps/:id/activate', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return errorResponse('INVALID_ID', 'Identificador de mapa no válido.', 400);
  const filePath = join(DATA_DIR, `${id}.mbtiles`);
  try {
    await stat(filePath);
    await addToTileConfig(id);
    await waitForTileServer(id, 'loaded');
    return c.json({ ok: true, id }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return errorResponse('FILE_NOT_FOUND', 'El archivo de este mapa no está cargado.', 404);
    console.error('[ortomosaicos-api] activate failed:', error instanceof Error ? error.message : 'unknown');
    return errorResponse('TILESERVER_NOT_READY', 'El servidor de mapas todavía no confirmó la publicación. Intente otra vez en un momento.', 503);
  }
});

app.delete('/internal/maps/:id', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return errorResponse('INVALID_ID', 'Identificador de mapa no válido.', 400);
  try {
    await removeFromTileConfig(id);
    await waitForTileServer(id, 'removed');
    return c.json({ ok: true, id, file_retained: true }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    console.error('[ortomosaicos-api] deactivate failed:', error instanceof Error ? error.message : 'unknown');
    return errorResponse('TILESERVER_NOT_READY', 'No se pudo confirmar el retiro del mapa. Intente otra vez.', 503);
  }
});

app.delete('/internal/maps/:id/file', async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) return errorResponse('INVALID_ID', 'Identificador de mapa no válido.', 400);

  try {
    return await withConfigLock(async () => {
      const config = await readConfig();
      if (Object.prototype.hasOwnProperty.call(config.data, id)) {
        return errorResponse('MAP_ACTIVE', 'Archive el mapa y espere a que se retire del servidor antes de eliminarlo.', 409);
      }

      const path = join(DATA_DIR, `${id}.mbtiles`);
      try {
        await rm(path);
        return c.json({ ok: true, id, file_deleted: true }, 200, { 'cache-control': 'no-store' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return c.json({ ok: true, id, file_deleted: false }, 200, { 'cache-control': 'no-store' });
        }
        throw error;
      }
    });
  } catch (error) {
    console.error('[ortomosaicos-api] file delete failed:', error instanceof Error ? error.message : 'unknown');
    return errorResponse('FILE_DELETE_FAILED', 'No se pudo eliminar el archivo del mapa. Intente otra vez.', 500);
  }
});

app.notFound((c) => errorResponse('NOT_FOUND', 'Ruta no encontrada.', 404));
app.onError((error, c) => {
  console.error('[ortomosaicos-api] request failed:', error instanceof Error ? error.message : 'unknown');
  return errorResponse('INTERNAL', 'Error interno.', 500);
});

export { app };
