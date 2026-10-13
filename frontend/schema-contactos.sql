-- Tabla de contactos del formulario publico (/api/contact) de ricardosanjur.com
-- Worker: ricardosanjur-web (D1: topografia-planos-db)
CREATE TABLE IF NOT EXISTS contactos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  email TEXT,
  telefono TEXT,
  tema TEXT,
  mensaje TEXT NOT NULL,
  creado_en TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  avisado INTEGER DEFAULT 0
);
