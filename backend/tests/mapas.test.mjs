import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const root = mkdtempSync(join(tmpdir(), 'ortomosaicos-test-'));
const mapsDir = join(root, 'maps');
const configPath = join(root, 'config.json');
const secret = 'test-secret-for-ortomosaicos-api-123456';

mkdirSync(mapsDir, { recursive: true });
writeFileSync(configPath, JSON.stringify({ options: { paths: { root: '/data' } }, data: {} }));

process.env.MAPS_DIR = mapsDir;
process.env.TILESERVER_CONFIG = configPath;
process.env.TILESERVER_URL = '';
process.env.MAPS_BACKEND_SECRET = secret;
process.env.MAPS_MAX_UPLOAD_BYTES = '1000000';

const { app } = await import('../dist/app.js');

function makeMbtiles(path) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE metadata (name TEXT, value TEXT)');
  db.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)');
  const addMetadata = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  addMetadata.run('format', 'png');
  addMetadata.run('minzoom', '15');
  addMetadata.run('maxzoom', '18');
  addMetadata.run('bounds', '-82.5,8.3,-82.4,8.5');
  addMetadata.run('center', '-82.45,8.4,16');
  db.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)')
    .run(16, 19000, 32000, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  db.close();
}

test('rechaza la API interna sin el secreto compartido', async () => {
  const response = await app.request('/internal/maps/ea3d7a2d-f98a-4c57-93d7-ec2c4b3f9881/activate', { method: 'POST' });
  assert.equal(response.status, 401);
});

test('valida, guarda, activa y archiva un MBTiles sin borrar el archivo', async () => {
  const id = 'ea3d7a2d-f98a-4c57-93d7-ec2c4b3f9881';
  const fixture = join(root, 'fixture.mbtiles');
  makeMbtiles(fixture);
  const bytes = readFileSync(fixture);

  const response = await app.request(`/internal/maps/${id}/file`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/vnd.sqlite3',
      'content-length': String(bytes.byteLength),
      'x-file-name': 'ortofoto-prueba.mbtiles',
    },
    body: bytes,
  });
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.file_name, 'ortofoto-prueba.mbtiles');
  assert.equal(uploaded.format, 'png');
  assert.deepEqual(uploaded.bounds, [-82.5, 8.3, -82.4, 8.5]);
  assert.deepEqual(uploaded.center, { lng: -82.45, lat: 8.4, zoom: 16 });
  assert.equal(statSync(join(mapsDir, `${id}.mbtiles`)).size, bytes.byteLength);

  const configAfterUpload = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(configAfterUpload.data[id], undefined, 'un borrador no debe quedar servido públicamente');

  const activated = await app.request(`/internal/maps/${id}/activate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(activated.status, 200);
  const configAfterActivate = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(configAfterActivate.data[id].mbtiles, join(mapsDir, `${id}.mbtiles`));

  const archived = await app.request(`/internal/maps/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(archived.status, 200);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).data[id], undefined);
  assert.equal(statSync(join(mapsDir, `${id}.mbtiles`)).isFile(), true, 'archivar conserva el archivo');

  const deleted = await app.request(`/internal/maps/${id}/file`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true, id, file_deleted: true });
  assert.equal(existsSync(join(mapsDir, `${id}.mbtiles`)), false, 'el borrado permanente libera el archivo');

  const reactivated = await app.request(`/internal/maps/${id}/activate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(reactivated.status, 404);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).data[id], undefined, 'no registra un archivo eliminado');
});

test('no permite borrar un MBTiles que sigue registrado en TileServer', async () => {
  const id = 'be3d7a2d-f98a-4c57-93d7-ec2c4b3f9882';
  const path = join(mapsDir, `${id}.mbtiles`);
  makeMbtiles(path);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.data[id] = { mbtiles: path };
  writeFileSync(configPath, JSON.stringify(config));

  const response = await app.request(`/internal/maps/${id}/file`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'MAP_ACTIVE');
  assert.equal(existsSync(path), true, 'un mapa activo conserva el archivo');

  delete config.data[id];
  writeFileSync(configPath, JSON.stringify(config));
});

test('el borrado de MBTiles requiere el secreto interno', async () => {
  const response = await app.request('/internal/maps/ae3d7a2d-f98a-4c57-93d7-ec2c4b3f9882/file', {
    method: 'DELETE',
  });
  assert.equal(response.status, 401);
});

test('valida el identificador y permite reintentar si el MBTiles ya no existe', async () => {
  const invalid = await app.request('/internal/maps/no-es-uuid/file', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_ID');

  const id = 'ce3d7a2d-f98a-4c57-93d7-ec2c4b3f9882';
  const missing = await app.request(`/internal/maps/${id}/file`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { ok: true, id, file_deleted: false });
});

test('rechaza un archivo que no es MBTiles y no conserva el temporal', async () => {
  const id = 'ae3d7a2d-f98a-4c57-93d7-ec2c4b3f9882';
  const response = await app.request(`/internal/maps/${id}/file`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/vnd.sqlite3',
      'content-length': '13',
      'x-file-name': 'no-es-mbtiles.mbtiles',
    },
    body: Buffer.from('no es mbtiles'),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_MBTILES');
  assert.equal(existsSync(join(mapsDir, `${id}.mbtiles`)), false);
  assert.equal(readFileSync(configPath, 'utf8').includes(id), false);
});

test('protege el servicio CAD con el mismo secreto de la API interna', async () => {
  const response = await app.request('/internal/cad/health');
  assert.equal(response.status, 401);
});

test('reenvía una conversión CAD por la ruta permitida y conserva sus metadatos', async () => {
  const originalFetch = globalThis.fetch;
  const originalConverterUrl = process.env.CAD_CONVERTER_URL;
  process.env.CAD_CONVERTER_URL = 'http://cad-test:8090';
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://cad-test:8090/api/convert');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-map-project-id'), 'pameda-2026');
    assert.equal(headers.get('authorization'), null, 'el secreto del Worker no se reenvía al contenedor');
    assert.match(headers.get('content-type') || '', /^multipart\/form-data;/i);
    return new Response('{"type":"FeatureCollection","features":[]}', {
      status: 200,
      headers: {
        'content-type': 'application/geo+json',
        'x-cad-layer-id': 'a'.repeat(32),
        'x-cad-feature-count': '0',
      },
    });
  };

  try {
    const form = new FormData();
    form.append('file', new Blob(['0\nEOF\n']), 'fixture.dxf');
    form.append('source_crs', 'EPSG:32617');
    const response = await app.request('/internal/cad/convert', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'x-map-project-id': 'pameda-2026',
        'x-admin-email': 'admin@example.com',
      },
      body: form,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/geo+json');
    assert.equal(response.headers.get('x-cad-layer-id'), 'a'.repeat(32));
    assert.deepEqual(await response.json(), { type: 'FeatureCollection', features: [] });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalConverterUrl === undefined) delete process.env.CAD_CONVERTER_URL;
    else process.env.CAD_CONVERTER_URL = originalConverterUrl;
  }
});

test('reenvía una conversión pública temporal sin project_id ni identidad admin', async () => {
  const originalFetch = globalThis.fetch;
  const originalConverterUrl = process.env.CAD_CONVERTER_URL;
  process.env.CAD_CONVERTER_URL = 'http://cad-test:8090';
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://cad-test:8090/api/convert-media');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-map-project-id'), null);
    assert.equal(headers.get('x-admin-email'), null);
    assert.equal(headers.get('authorization'), null);
    return new Response('temporary image', {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-disposition': 'attachment; filename="page-1.png"',
        'x-cad-export-bytes': '15',
      },
    });
  };

  try {
    const form = new FormData();
    form.append('file', new Blob(['%PDF-test'], { type: 'application/pdf' }), 'plan.pdf');
    form.append('target_format', 'png');
    const response = await app.request('/internal/cad/public/convert-media', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'x-map-project-id': 'should-not-forward',
        'x-admin-email': 'forged@example.com',
      },
      body: form,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="page-1.png"');
    assert.equal(response.headers.get('x-cad-export-bytes'), '15');
    assert.equal(await response.text(), 'temporary image');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalConverterUrl === undefined) delete process.env.CAD_CONVERTER_URL;
    else process.env.CAD_CONVERTER_URL = originalConverterUrl;
  }
});

test('rechaza un cuerpo público chunked que supera el límite sin Content-Length', async () => {
  const originalFetch = globalThis.fetch;
  const originalConverterUrl = process.env.CAD_CONVERTER_URL;
  process.env.CAD_CONVERTER_URL = 'http://cad-test:8090';
  let forwardedBytes = 0;
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('content-length'), null);
    const reader = init?.body?.getReader();
    assert.ok(reader, 'el proxy transmite el cuerpo como stream');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        forwardedBytes += value.byteLength;
      }
    } catch {
      // Emula un upstream que responde 200 aunque el body stream termine truncado.
      return new Response('upstream accepted truncated body');
    }
    return new Response('unexpected success');
  };

  try {
    const request = new Request('http://localhost/internal/cad/public/convert-media', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'multipart/form-data; boundary=test-boundary',
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(26_000_001));
          controller.close();
        },
      }),
      duplex: 'half',
    });
    assert.equal(request.headers.get('content-length'), null);

    const response = await app.fetch(request);
    assert.equal(response.status, 413);
    assert.equal(forwardedBytes, 0, 'el chunk que excede el límite nunca llega al conversor');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalConverterUrl === undefined) delete process.env.CAD_CONVERTER_URL;
    else process.env.CAD_CONVERTER_URL = originalConverterUrl;
  }
});

test('no expone rutas CAD que no estén en la lista permitida', async () => {
  const response = await app.request('/internal/cad/delete', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(response.status, 404);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
