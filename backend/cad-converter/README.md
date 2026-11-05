# Convertidor CAD/GIS y documental

Servicio privado para convertir DWG/DXF/SHP/ZIP/KML/GeoJSON/GeoPackage a GeoJSON WGS84, superponer capas en el visor, exportar capas a KML/GeoJSON y convertir DWG/DXF a SVG/PDF/JPG/PNG y PDF a JPG/PNG.

## Seguridad y topología

- El servicio se publica **solo en la red Docker** `rsanjur-mapas_mapas`. No tiene `ports:` y no debe añadirse a Nginx Proxy Manager ni abrirse en el firewall.
- El puerto `8090` es interno al contenedor. En el VPS ese puerto ya lo usa Cotiza en `127.0.0.1`; por eso no se publica en el host.
- El navegador habla con el Worker de `ricardosanjur.com`: las conversiones temporales son públicas y el guardado/publicación de capas oficiales exige sesión administrativa RS ID. El backend Hono solo acepta las rutas permitidas con su secreto interno.
- Los originales, GeoJSON, exportaciones y auditoría viven en `/opt/mapas/archivos_clientes`, con propietario numérico `10001:10001` y permisos `0750`. No se usa `chmod 777`.
- No se habilita CORS: el navegador nunca llama directamente a FastAPI. Las subidas, archivos ZIP, nombres, CRS, formatos y tamaños se validan antes de convertir. El extractor ZIP rechaza rutas ascendentes, enlaces y archivos comprimidos desproporcionados.
- Los originales, las capas y las exportaciones se conservan permanentemente según el manual; no existe endpoint de borrado ni vencimiento automático. `logs/historial_subidas.csv` es append-only desde la aplicación, pero esto no equivale a inmutabilidad WORM: para resistir cambios de root se requieren respaldos/almacenamiento WORM externo.
- El manual no define aviso de privacidad, consentimiento, derechos de eliminación ni tratamiento de planos de clientes. El panel muestra la retención y exige autorización para conservar el material; revisar la política legal del sitio antes de habilitar cargas de terceros. Esto no constituye una garantía legal de cumplimiento.
- LibreDWG 0.14 se construye desde el tarball oficial con SHA-256 fijado en el Dockerfile; está licenciado bajo GPL-3.0-or-later. Si se redistribuye la imagen, hay que cumplir los términos de esa licencia.

## Uso público temporal

- El Worker expone `POST /api/mapas/cad/overlay` y `POST /api/mapas/cad/convert-media` sin login. El Hono interno exige igualmente `MAPAS_BACKEND_SECRET`; FastAPI no se expone al navegador.
- Las conversiones públicas aceptan hasta 25 MB y 40 páginas PDF; el límite de frecuencia es 5 solicitudes por 15 minutos y dirección de conexión. El Worker guarda en D1 únicamente un HMAC de la IP para el contador, nunca la IP ni el nombre del archivo.
- Sin `X-Map-Project-ID`, FastAPI procesa los uploads y resultados en un directorio aleatorio de `/tmp`, no consulta ni escribe `/opt/mapas/archivos_clientes`, y no registra auditoría. El Worker envía `Cache-Control: no-store`; FastAPI elimina el directorio al terminar la descarga y también ante errores. El máximo público está fijado en `25000000` bytes y coincide con el control del Worker.
- `/api/admin/mapas/cad/*` conserva el flujo separado de RS ID para guardar, listar, mostrar y eliminar capas oficiales. El modo público nunca crea ni borra capas de mapas.

## Formatos y límites

- Superposición: DWG, DXF, SHP (es preferible ZIP con `.shp/.shx/.dbf/.prj`), KML, GeoJSON y GeoPackage. La salida es GeoJSON EPSG:4326.
- Exportación: DWG/DXF a SVG/PDF/JPG/PNG/KML/GeoJSON; PDF a JPG/PNG; capas GIS a KML/GeoJSON. Los PDF de varias páginas se descargan como ZIP de imágenes.
- Tamaño máximo de entrada y salida: 90 MB. PDF: máximo 40 páginas y 150/300 DPI. Conversión de a una tarea a la vez.
- DWG sin sistema de coordenadas y SHP sin `.prj` requieren elegir EPSG:4326, EPSG:32617 o EPSG:26717. `Auto` conserva el CRS que venga en el archivo. Verificarlo antes de publicar el resultado.
- LibreDWG no garantiza compatibilidad perfecta con todas las versiones/entidades DWG. Probar con planos reales representativos antes de depender de ellos.
- Al exportar DWG/DXF a GeoJSON, las entidades que no admiten una geometría vectorial compatible (por ejemplo, algunos sólidos 3D o anotaciones) pueden omitirse. PDF/SVG sirven para revisar la presentación visual del plano.

## Construcción y prueba

```sh
docker compose -f compose.yaml build
docker compose -f compose.yaml run --rm --no-deps cad-converter python -m unittest discover -s tests -v
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
```

`/docs` y `/health` solo existen en la red interna. El Worker expone conversión temporal pública con límite y reserva las operaciones que escriben en el mapa para administradores.

La prueba `sh tests/test_http_smoke.sh` ejecuta el API solo en loopback del contenedor y comprueba `/docs`, la carga real DXF→GeoJSON, la capa guardada, el original intacto y el CSV de auditoría. En staging, ejecútela con `--network none --read-only` y `/tmp` montado como `tmpfs`.

## Despliegue aislado en el VPS

Copie `backend/cad-converter/` completo al checkout del backend del VPS y ejecute como root:

```sh
bash /opt/ricardosanjur-mapas/app/cad-converter/install-vps.sh
```

El instalador verifica que ya exista `rsanjur-mapas_mapas`, conserva los archivos existentes, rechaza carpetas de datos con propietario inesperado y solo construye/actualiza el proyecto Compose `cad-converter`. No ejecuta Compose en el proyecto de mapas, no reinicia TileServer y no toca los MBTiles.
