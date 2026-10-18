// Empaca los artículos del repo (src/content/blog/*.md y *.html) en worker/blog-archivos.ts.
// Por qué: el worker de Cloudflare no lee disco, y el panel tiene que listar todo lo publicado.
// Correr antes de desplegar si se agrega o cambia un artículo del repo:
//   node scripts/empacar-blog.mjs
import fs from 'node:fs';
import path from 'node:path';

const base = 'src/content/blog';
// Recorre también las subcarpetas: los .md de la colección de Astro siguen ahí, y
// en plantillas/ quedan las copias que se pasan una vez a la base.
const archivos = [];
const recorrer = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(ruta);
    else if (/\.(md|html)$/i.test(e.name)) archivos.push(ruta.replace(base + path.sep, '').replace(/\\/g, '/'));
  }
};
recorrer(base);
archivos.sort();
const items = archivos.map((archivo) => ({
  archivo,
  texto: fs.readFileSync(path.join(base, archivo), 'utf8'),
}));

const salida =
  '/**\n * Artículos del blog que están como archivo en el repo (los que escribí yo).\n *\n' +
  ' * No se pueden leer en tiempo de ejecución: el worker de Cloudflare no tiene\n' +
  ' * disco, así que el contenido se mete aquí al compilar con `node scripts/empacar-blog.mjs`.\n' +
  ' * Si se agrega o cambia un archivo de src/content/blog/, hay que correrlo antes de desplegar.\n' +
  ' */\n' +
  'export const ARCHIVOS_BLOG: { archivo: string; texto: string }[] = ' +
  JSON.stringify(items, null, 0) +
  ';\n';

fs.mkdirSync('worker', { recursive: true });
fs.writeFileSync('worker/blog-archivos.ts', salida);
console.log('empacados ' + items.length + ' artículos: ' + archivos.join(', '));
