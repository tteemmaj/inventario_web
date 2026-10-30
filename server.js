require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const app = express();

function cargarCA() {
  const f = process.env.DB_CA_FILE;
  if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  if (process.env.DB_CA) return process.env.DB_CA.replace(/\\n/g, '\n');
  return null;
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // Aiven exige SSL (ssl-mode=REQUIRED). Si hay CA (archivo o variable) se valida el certificado.
  ssl: cargarCA() ? { ca: cargarCA() } : { rejectUnauthorized: false },
  dateStrings: true,          // DATE -> 'YYYY-MM-DD' (evita desfases de zona horaria)
  waitForConnections: true,
  connectionLimit: 5,
});

if (process.env.APP_PASS) {
  app.use((req, res, next) => {
    const [tipo, token] = (req.headers.authorization || '').split(' ');
    if (tipo === 'Basic' && token) {
      const [u, ...p] = Buffer.from(token, 'base64').toString().split(':');
      if (u === (process.env.APP_USER || 'admin') && p.join(':') === process.env.APP_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="ALVIDE"').status(401).send('Acceso restringido');
  });
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const hoyGT = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' });
const primeroDeMes = () => hoyGT().slice(0, 8) + '01';

function rango(req) {
  const desde = FECHA.test(req.query.desde || '') ? req.query.desde : primeroDeMes();
  const hasta = FECHA.test(req.query.hasta || '') ? req.query.hasta : hoyGT();
  return { desde, hasta };
}

const ruta = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    console.error('Error en', req.path, '->', e.code, e.message);
    res.status(500).json({
      error: 'No se pudo consultar la base de datos.',
      detalle: process.env.DEBUG === '1' ? `${e.code || ''} ${e.message}` : undefined,
    });
  }
};

app.get('/api/inicio', ruta(async () => {
  const hoy = hoyGT();
  const [[resumen]] = await pool.query(
    'SELECT COUNT(*) AS ventas, COALESCE(SUM(total_final),0) AS total FROM venta WHERE fecha = ?', [hoy]);
  // Supuesto: la columna del mínimo se llama existencia_minima (ajustar si es otra).
  const [bajo] = await pool.query(
    `SELECT codigo, nombre, existencia_actual FROM producto
     WHERE existencia_actual > 0 AND existencia_actual <= existencia_minima
     ORDER BY existencia_actual LIMIT 100`);
  const [agotado] = await pool.query(
    `SELECT codigo, nombre, existencia_actual FROM producto
     WHERE existencia_actual <= 0 ORDER BY nombre LIMIT 100`);
  return { hoy, resumen, bajo, agotado };
}));

app.get('/api/reportes/formas-pago', ruta(async () => {
  const [r] = await pool.query('SELECT DISTINCT forma_pago FROM venta WHERE forma_pago IS NOT NULL ORDER BY 1');
  return r.map((x) => x.forma_pago);
}));

app.get('/api/reportes/ventas', ruta(async (req) => {
  const { desde, hasta } = rango(req);
  const fp = req.query.formaPago && req.query.formaPago.toUpperCase() !== 'TODOS' ? req.query.formaPago : null;
  const params = [desde, hasta];
  if (fp) params.push(fp);
  const [filas] = await pool.query(
    `SELECT v.numero_venta, v.fecha, c.nombre AS cliente,
            v.subtotal_general, v.total_descuentos, v.total_iva, v.total_final,
            (SELECT COALESCE(SUM(d.cantidad_solicitada),0) FROM detalle_venta d
              WHERE d.numero_venta = v.numero_venta) AS cantidad
     FROM venta v INNER JOIN cliente c ON c.codigo = v.codigo_cliente
     WHERE v.fecha BETWEEN ? AND ? ${fp ? 'AND v.forma_pago = ?' : ''}
     ORDER BY v.fecha DESC, v.numero_venta DESC`, params);
  const total = filas.reduce((s, f) => s + Number(f.total_final), 0);
  return {
    desde, hasta, filas,
    resumen: { total, ventas: filas.length, promedio: filas.length ? total / filas.length : 0 },
  };
}));

app.get('/api/reportes/top-productos', ruta(async (req) => {
  const { desde, hasta } = rango(req);
  const [filas] = await pool.query(
    `SELECT p.nombre AS producto, SUM(d.cantidad_solicitada) AS cantidad, SUM(d.total_linea) AS total
     FROM detalle_venta d
     INNER JOIN venta v ON v.numero_venta = d.numero_venta
     INNER JOIN producto p ON p.codigo = d.codigo_producto
     WHERE v.fecha BETWEEN ? AND ?
     GROUP BY p.codigo, p.nombre
     ORDER BY cantidad DESC, total DESC LIMIT 50`, [desde, hasta]);
  return { desde, hasta, filas };
}));

app.get('/api/historial', ruta(async (req) => {
  const tipo = (req.query.tipo || 'TODOS').toUpperCase();
  const incluirCompras = tipo === 'TODOS' || tipo === 'COMPRA';
  const incluirVentas = tipo === 'TODOS' || tipo === 'VENTA';
  const desde = FECHA.test(req.query.desde || '') ? req.query.desde : null;
  const hasta = FECHA.test(req.query.hasta || '') ? req.query.hasta : null;
  const q = String(req.query.q || '').trim();
  const patron = `%${q}%`;

  const compras = `
    SELECT p.codigo AS id, CAST(NULL AS DATE) AS fecha,
           'COMPRA' COLLATE utf8mb4_unicode_ci AS tipo,
           p.nombre AS referencia, (p.precio_compra * p.existencia_actual) AS total,
           CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS usuario
    FROM producto p WHERE p.tipo_producto IN ('MATERIA_PRIMA','HERRAMIENTA')`;

  const params = [];
  let filtroFecha = '';
  if (desde) { filtroFecha += ' AND v.fecha >= ?'; params.push(desde); }
  if (hasta) { filtroFecha += ' AND v.fecha <= ?'; params.push(hasta); }

  const ventas = `
    SELECT v.numero_venta AS id, v.fecha AS fecha,
           'VENTA' COLLATE utf8mb4_unicode_ci AS tipo,
           c.nombre AS referencia, v.total_final AS total, u.nombre_completo AS usuario
    FROM venta v
    JOIN cliente c ON c.codigo = v.codigo_cliente
    JOIN usuario u ON u.id_usuario = v.id_usuario_responsable
    WHERE 1=1 ${filtroFecha}`;

  const partes = [];
  if (incluirCompras) partes.push(compras);
  if (incluirVentas) partes.push(ventas);
  if (!partes.length) return [];

  const [filas] = await pool.query(
    `SELECT * FROM (${partes.join(' UNION ALL ')}) h
     WHERE (? = '' OR h.id LIKE ? OR h.referencia LIKE ? OR h.usuario LIKE ?
            OR DATE_FORMAT(h.fecha, '%d/%m/%Y') LIKE ?)
     ORDER BY h.fecha DESC, h.id LIMIT 1000`,
    [...params, q, patron, patron, patron, patron]);
  return filas;
}));

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('ALVIDE web en puerto', process.env.PORT || 3000));


const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('ALVIDE web en puerto', PORT));