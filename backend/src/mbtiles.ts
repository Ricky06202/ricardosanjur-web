import { createRequire } from 'node:module';

type SqliteStatement = {
  all: (...values: unknown[]) => Record<string, unknown>[];
  get: (...values: unknown[]) => Record<string, unknown> | undefined;
};

type SqliteDatabase = {
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

type DatabaseSyncConstructor = new (
  path: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };

export type MbtilesInspection = {
  format: 'png' | 'jpg' | 'jpeg' | 'webp';
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number] | null;
  center: { lng: number; lat: number; zoom: number } | null;
};

export class MbtilesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MbtilesValidationError';
  }
}

function readZoom(value: unknown, fallback: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 24 ? parsed : fallback;
}

function readBounds(value: unknown): [number, number, number, number] | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [west, south, east, north] = parts;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  return [west, south, east, north];
}

function readCenter(
  value: unknown,
  bounds: [number, number, number, number] | null,
  minzoom: number,
  maxzoom: number,
): { lng: number; lat: number; zoom: number } | null {
  if (typeof value === 'string') {
    const parts = value.split(',').map((part) => Number(part.trim()));
    if (parts.length >= 2 && parts.slice(0, 2).every(Number.isFinite)) {
      const [lng, lat] = parts;
      const zoom = parts.length >= 3 && Number.isFinite(parts[2])
        ? Math.max(minzoom, Math.min(maxzoom, parts[2]))
        : Math.min(maxzoom, Math.max(minzoom, 14));
      if (lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) return { lng, lat, zoom };
    }
  }
  if (!bounds) return null;
  const [west, south, east, north] = bounds;
  return {
    lng: (west + east) / 2,
    lat: (south + north) / 2,
    zoom: Math.min(maxzoom, Math.max(minzoom, 14)),
  };
}

/** Open an uploaded MBTiles database read-only and verify it is a usable raster map. */
export function inspectMbtiles(path: string): MbtilesInspection {
  let db: SqliteDatabase;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    throw new MbtilesValidationError('El archivo no es una base MBTiles válida.');
  }

  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
    );
    if (!tables.has('metadata') || !tables.has('tiles')) {
      throw new MbtilesValidationError('El archivo no contiene las tablas MBTiles requeridas.');
    }

    let metadataRows: Record<string, unknown>[];
    let firstTile: Record<string, unknown> | undefined;
    try {
      metadataRows = db.prepare('SELECT name, value FROM metadata').all();
      firstTile = db.prepare('SELECT length(tile_data) AS bytes FROM tiles LIMIT 1').get();
    } catch {
      throw new MbtilesValidationError('No se pudieron leer los metadatos o las teselas del archivo.');
    }

    if (!firstTile || Number(firstTile.bytes) <= 0) {
      throw new MbtilesValidationError('El archivo no contiene teselas para mostrar.');
    }

    const metadata = new Map<string, string>();
    for (const row of metadataRows) {
      if (typeof row.name === 'string') metadata.set(row.name, String(row.value ?? ''));
    }

    const format = (metadata.get('format') || '').trim().toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(format)) {
      throw new MbtilesValidationError('El MBTiles debe contener una ortofoto raster PNG, JPG o WebP.');
    }

    const minzoom = readZoom(metadata.get('minzoom'), 0);
    const maxzoom = readZoom(metadata.get('maxzoom'), 22);
    if (minzoom > maxzoom) throw new MbtilesValidationError('Los niveles de zoom del MBTiles no son válidos.');

    const bounds = readBounds(metadata.get('bounds'));
    const center = readCenter(metadata.get('center'), bounds, minzoom, maxzoom);
    return { format: format as MbtilesInspection['format'], minzoom, maxzoom, bounds, center };
  } catch (error) {
    if (error instanceof MbtilesValidationError) throw error;
    throw new MbtilesValidationError('El archivo está dañado o no tiene la estructura MBTiles requerida.');
  } finally {
    db.close();
  }
}
