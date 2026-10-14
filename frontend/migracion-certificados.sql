-- Certificados verificables (modulo aditivo).
-- Guarda SOLO la huella SHA-256 del documento y sus datos; el archivo nunca se almacena.
CREATE TABLE IF NOT EXISTS certificados (
  id TEXT PRIMARY KEY,
  huella TEXT NOT NULL,
  nombre TEXT,
  mime TEXT,
  tamano INTEGER,
  descripcion TEXT,
  emisor TEXT,
  emitido_en TEXT NOT NULL,
  admin_token TEXT
);

CREATE INDEX IF NOT EXISTS idx_certificados_huella ON certificados (huella);
CREATE INDEX IF NOT EXISTS idx_certificados_emitido ON certificados (emitido_en);
