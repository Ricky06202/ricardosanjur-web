/* Ficha de los artículos HTML del blog (src/content/blog/*.html y *.md).
 *
 * Aquí va solo lo que el archivo no tiene y el sitio sí necesita: la fecha
 * (para el orden del blog y el sitemap) y el resumen (lo que se ve en Google y
 * al compartir el link). El link es siempre /blog/<nombre del archivo>.
 *
 * Para agregar uno nuevo: dejar el archivo en src/content/blog/ y poner aquí su
 * entrada con el mismo nombre de archivo, sin .html.
 */
export const FICHAS: Record<string, { fecha: string; titulo: string; resumen: string }> = {
  'guia-segregar-finca-panama': {
    fecha: '2026-10-18',
    titulo: 'Guía paso a paso para segregar una finca en Panamá (ANATI, MIVIOT y Municipio)',
    resumen:
      'Paso a paso para segregar una finca en Panamá: análisis en campo, levantamiento, expediente y la ruta MIVIOT ➔ ANATI ➔ MIVIOT, con la advertencia de oro antes de escriturar.',
  },
  'levantamiento-html': {
    fecha: '2026-10-18',
    titulo: '¿Cuánto cuesta un levantamiento topográfico en Panamá y qué factores influyen en el precio?',
    resumen:
      'Rangos de precios de un levantamiento topográfico en Panamá, por qué varían tanto y qué factores determinan el valor real de un trabajo bien ejecutado.',
  },
  'construir-chiriqui-html': {
    fecha: '2026-10-18',
    titulo: '¿Cuándo necesitas un levantamiento topográfico antes de construir en Chiriquí? 5 Errores Costosos',
    resumen:
      'Cinco casos reales de construcciones y lotes mal levantados en Chiriquí, y por qué el estudio topográfico se hace antes del primer bloque.',
  },
};
