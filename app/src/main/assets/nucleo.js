/*
 * Surtidor Faustino — núcleo (sin pantalla).
 * Toda la lógica que decide si un cupón vale, qué se canjea y qué se exporta, separada de la interfaz para poder probarla con Node (ver prueba/prueba.js).
 * Funciona sin conexión: no hay ninguna llamada de red.
 *
 * Formatos (los define el Sistema de Gobierno Hospitalario, App\Support\IntercambioCombustible):
 *  - QR del cupón ........ SGHC1:<folio>:<código>
 *  - Cupones activos ..... { formato: "SGHC-LOTE-1", datos: "<JSON como texto>", firma: base64, clave: base64 }  (firma Ed25519 sobre los bytes UTF-8 de `datos`)
 *  - Canjes .............. { formato: "SGHC-CANJES-1", lote, expendedor, exportado, canjes: [{folio, fecha, lote, prueba}] }
 *    prueba = HMAC-SHA256(llave = código sin guion en mayúsculas, mensaje = "folio|fecha|lote"), los 20 primeros caracteres hex.
 */
(function (raiz) {
  'use strict';

  var FORMATO_LOTE = 'SGHC-LOTE-1';
  var FORMATO_CANJES = 'SGHC-CANJES-1';
  var VERSION_ESTADO = 1;

  /** WebCrypto, si el teléfono lo ofrece (solo en contextos seguros). Si no, se usa el cálculo propio de más abajo: la aplicación no depende de él. */
  function subtle() {
    if (api && api.sinSubtle) return null; // para probar el respaldo
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || raiz.crypto;
    return c && c.subtle ? c.subtle : null;
  }

  /* SHA-256 y HMAC-SHA256 en JavaScript puro (respaldo cuando no hay WebCrypto). Se prueban contra el cálculo de Node en prueba/prueba.js. */
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256js(datos) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var n = datos.length;
    var total = (((n + 9 + 63) >> 6) << 6);
    var m = new Uint8Array(total);
    m.set(datos);
    m[n] = 0x80;
    var bits = n * 8;
    m[total - 4] = (bits >>> 24) & 255; m[total - 3] = (bits >>> 16) & 255; m[total - 2] = (bits >>> 8) & 255; m[total - 1] = bits & 255;
    m[total - 8] = Math.floor(n / 0x20000000) & 255; // parte alta de la longitud en bits (archivos < 512 MB)
    var w = new Array(64);
    for (var o = 0; o < total; o += 64) {
      for (var i = 0; i < 16; i++) w[i] = ((m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3]) | 0;
      for (i = 16; i < 64; i++) {
        var a15 = w[i - 15], a2 = w[i - 2];
        var s0 = ((a15 >>> 7) | (a15 << 25)) ^ ((a15 >>> 18) | (a15 << 14)) ^ (a15 >>> 3);
        var s1 = ((a2 >>> 17) | (a2 << 15)) ^ ((a2 >>> 19) | (a2 << 13)) ^ (a2 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
        var ch = (E & F) ^ (~E & G);
        var t1 = (H + S1 + ch + K256[i] + w[i]) | 0;
        var S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
        var mj = (A & B) ^ (A & C) ^ (B & C);
        var t2 = (S0 + mj) | 0;
        H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      h[0] = (h[0] + A) | 0; h[1] = (h[1] + B) | 0; h[2] = (h[2] + C) | 0; h[3] = (h[3] + D) | 0; h[4] = (h[4] + E) | 0; h[5] = (h[5] + F) | 0; h[6] = (h[6] + G) | 0; h[7] = (h[7] + H) | 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[4 * i] = (h[i] >>> 24) & 255; out[4 * i + 1] = (h[i] >>> 16) & 255; out[4 * i + 2] = (h[i] >>> 8) & 255; out[4 * i + 3] = h[i] & 255; }
    return out;
  }

  function hmacSha256js(llave, mensaje) {
    if (llave.length > 64) llave = sha256js(llave);
    var k = new Uint8Array(64); k.set(llave);
    var ipad = new Uint8Array(64 + mensaje.length), opad = new Uint8Array(64 + 32);
    for (var i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
    ipad.set(mensaje, 64);
    opad.set(sha256js(ipad), 64);
    return sha256js(opad);
  }

  async function sha256(bytes) {
    var s = subtle();
    return s ? new Uint8Array(await s.digest('SHA-256', bytes)) : sha256js(bytes);
  }

  async function hmacSha256(llave, mensaje) {
    var s = subtle();
    if (!s) return hmacSha256js(llave, mensaje);
    var k = await s.importKey('raw', llave, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await s.sign('HMAC', k, mensaje));
  }

  function utf8(texto) { return new TextEncoder().encode(texto); }

  function deBase64(texto) {
    var bin = atob(String(texto).replace(/\s+/g, ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function aHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  /** La huella de la llave pública del hospital: AB12-CD34-EF56-7890 (igual que la que muestra el sistema). */
  async function huella(clavePublicaBase64) {
    var h = aHex(await sha256(deBase64(clavePublicaBase64))).toUpperCase().slice(0, 16);
    return h.match(/.{4}/g).join('-');
  }

  /** Normaliza un código escrito a mano: mayúsculas, sin espacios, con el guion en medio (XXXXX-XXXXX). */
  function normalizarCodigo(c) {
    var s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.length === 10 ? s.slice(0, 5) + '-' + s.slice(5) : s;
  }

  /** Normaliza un folio escrito a mano: acepta «COMB-2026-00012», «2026-12» o solo «12» (año en curso). */
  function normalizarFolio(f, ahora) {
    var s = String(f || '').toUpperCase().trim();
    var m = s.match(/^COMB-(\d{4})-(\d{1,5})$/);
    if (m) return 'COMB-' + m[1] + '-' + ('00000' + m[2]).slice(-5);
    m = s.match(/^(\d{4})-(\d{1,5})$/);
    if (m) return 'COMB-' + m[1] + '-' + ('00000' + m[2]).slice(-5);
    m = s.match(/^(\d{1,5})$/);
    if (m) return 'COMB-' + (ahora || new Date()).getFullYear() + '-' + ('00000' + m[1]).slice(-5);
    return s;
  }

  /** Lo que lee el escáner → { folio, codigo }, o null si no es un QR de cupón de combustible. */
  function leerQr(texto) {
    var m = /^SGHC1:(COMB-\d{4}-\d{5}):([A-Z0-9]{5}-[A-Z0-9]{5})$/.exec(String(texto || '').trim());
    return m ? { folio: m[1], codigo: m[2] } : null;
  }

  /** «2026-11-13T09:30:00-05:00» en la hora del teléfono. */
  function isoLocal(d) {
    function p(n, l) { return ('0000' + n).slice(-(l || 2)); }
    var off = -d.getTimezoneOffset();
    var signo = off >= 0 ? '+' : '-';
    off = Math.abs(off);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      signo + p(Math.floor(off / 60)) + ':' + p(off % 60);
  }

  function fechaLocal(d) {
    function p(n) { return ('0' + n).slice(-2); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** La prueba de un canje (20 hex). Solo quien tiene el código del cupón puede producirla. */
  async function prueba(codigo, folio, fecha, lote) {
    var firma = await hmacSha256(utf8(String(codigo).toUpperCase().replace(/-/g, '')), utf8(folio + '|' + fecha + '|' + lote));
    return aHex(firma).slice(0, 20);
  }

  /* ---------- el estado que se guarda en el teléfono ---------- */

  function estadoNuevo() {
    return { version: VERSION_ESTADO, clavePublica: null, huella: null, expendedor: '', lotes: {}, cupones: {} };
  }

  /**
   * Comprueba un archivo de cupones activos: formato, firma y datos. `nacl` es tweetnacl. No toca el estado: devuelve los datos y la llave para que la pantalla pida
   * confirmar la huella la primera vez.
   * @returns {{ok:boolean, error?:string, datos?:object, clave?:string}}
   */
  function verificarLote(texto, nacl) {
    var doc;
    try { doc = JSON.parse(texto); } catch (e) { return { ok: false, error: 'El archivo no se puede leer: no es un archivo de cupones.' }; }
    if (!doc || doc.formato !== FORMATO_LOTE || typeof doc.datos !== 'string' || !doc.firma || !doc.clave) {
      return { ok: false, error: 'Este archivo no es un archivo de cupones activos del hospital.' };
    }
    var valida = false;
    try { valida = nacl.sign.detached.verify(utf8(doc.datos), deBase64(doc.firma), deBase64(doc.clave)); } catch (e) { valida = false; }
    if (!valida) return { ok: false, error: 'La firma del archivo no es válida: el archivo está alterado o dañado. Pídele a la Dirección que te lo mande otra vez.' };
    var datos;
    try { datos = JSON.parse(doc.datos); } catch (e) { return { ok: false, error: 'El archivo está dañado.' }; }
    if (!datos || !Array.isArray(datos.cupones) || !datos.lote || !datos.semana_inicio || !datos.semana_fin) return { ok: false, error: 'El archivo está incompleto.' };
    return { ok: true, datos: datos, clave: doc.clave };
  }

  /**
   * Mete los cupones de un archivo verificado en el estado. Si el cupón ya estaba (de un archivo anterior) conserva su canje. Quita los canjes ya enviados de semanas
   * de hace más de 30 días para que el teléfono no acumule.
   */
  function integrarLote(estado, datos, ahora) {
    estado.lotes[datos.lote] = { generado: datos.generado || '', desde: datos.semana_inicio, hasta: datos.semana_fin, hospital: datos.hospital || '' };
    var nuevos = 0;
    datos.cupones.forEach(function (c) {
      var previo = estado.cupones[c.folio];
      if (!previo) nuevos++;
      estado.cupones[c.folio] = {
        folio: c.folio, codigo: normalizarCodigo(c.codigo), chofer: c.chofer || '', matricula: c.matricula || '', tipo: c.tipo || '', litros: Number(c.litros) || 0,
        dias: c.dias || '', lote: datos.lote, desde: datos.semana_inicio, hasta: datos.semana_fin, canje: previo ? previo.canje : null,
      };
    });
    var limite = fechaLocal(new Date((ahora || new Date()).getTime() - 30 * 86400000));
    Object.keys(estado.cupones).forEach(function (f) {
      var c = estado.cupones[f];
      if (c.canje && c.canje.exportado && c.hasta < limite) delete estado.cupones[f];
    });
    return { nuevos: nuevos, total: datos.cupones.length };
  }

  /**
   * ¿Vale este cupón? resultado: valido | canjeado | fuera_de_semana | codigo_no_coincide | no_esta.
   * `ahora` es la hora del teléfono (se pasa para poder probarlo).
   */
  function evaluar(estado, folio, codigo, ahora) {
    var c = estado.cupones[folio];
    if (!c) return { resultado: 'no_esta', cupon: null };
    if (normalizarCodigo(codigo) !== c.codigo) return { resultado: 'codigo_no_coincide', cupon: null };
    if (c.canje) return { resultado: 'canjeado', cupon: c };
    var hoy = fechaLocal(ahora || new Date());
    if (hoy < c.desde) return { resultado: 'fuera_de_semana', cupon: c, antes: true };
    if (hoy > c.hasta) return { resultado: 'fuera_de_semana', cupon: c, antes: false };
    return { resultado: 'valido', cupon: c };
  }

  /** Marca el cupón como canjeado (se entregó el combustible; los litros son siempre los del cupón). */
  async function canjear(estado, folio, ahora) {
    var c = estado.cupones[folio];
    if (!c) throw new Error('El cupón no está en el teléfono.');
    if (c.canje) throw new Error('Este cupón ya estaba canjeado.');
    var fecha = isoLocal(ahora || new Date());
    c.canje = { fecha: fecha, prueba: await prueba(c.codigo, c.folio, fecha, c.lote), exportado: false };
    return c.canje;
  }

  /** Deshace un canje que todavía no se ha enviado (por equivocación). */
  function deshacerCanje(estado, folio) {
    var c = estado.cupones[folio];
    if (!c || !c.canje) throw new Error('Ese cupón no está canjeado.');
    if (c.canje.exportado) throw new Error('Ese canje ya se envió a la Dirección: no se puede deshacer aquí.');
    c.canje = null;
  }

  function pendientes(estado) {
    return Object.keys(estado.cupones).map(function (f) { return estado.cupones[f]; }).filter(function (c) { return c.canje && !c.canje.exportado; });
  }

  function todosLosCanjes(estado) {
    return Object.keys(estado.cupones).map(function (f) { return estado.cupones[f]; }).filter(function (c) { return c.canje; })
      .sort(function (a, b) { return a.canje.fecha < b.canje.fecha ? 1 : -1; });
  }

  /** El archivo de canjes para mandárselo a la Dirección. Con `todos` va todo lo canjeado; si no, solo lo que no se ha enviado. */
  function construirCanjes(estado, ahora, todos) {
    var lista = (todos ? todosLosCanjes(estado) : pendientes(estado)).sort(function (a, b) { return a.canje.fecha < b.canje.fecha ? -1 : 1; });
    var lotes = {};
    lista.forEach(function (c) { lotes[c.lote] = true; });
    var codigos = Object.keys(lotes).sort();
    return {
      formato: FORMATO_CANJES,
      lote: codigos[codigos.length - 1] || '',
      expendedor: estado.expendedor || '',
      exportado: isoLocal(ahora || new Date()),
      canjes: lista.map(function (c) { return { folio: c.folio, fecha: c.canje.fecha, lote: c.lote, prueba: c.canje.prueba }; }),
    };
  }

  /** Marca como enviados los canjes que iban en el archivo (cuando el expendedor ya se lo mandó a la Dirección). */
  function marcarEnviados(estado, canjes) {
    canjes.forEach(function (x) { var c = estado.cupones[x.folio]; if (c && c.canje) c.canje.exportado = true; });
  }

  var api = {
    sinSubtle: false, sha256: sha256, hmacSha256: hmacSha256,
    FORMATO_LOTE: FORMATO_LOTE, FORMATO_CANJES: FORMATO_CANJES, huella: huella, normalizarCodigo: normalizarCodigo, normalizarFolio: normalizarFolio, leerQr: leerQr,
    isoLocal: isoLocal, fechaLocal: fechaLocal, prueba: prueba, estadoNuevo: estadoNuevo, verificarLote: verificarLote, integrarLote: integrarLote, evaluar: evaluar,
    canjear: canjear, deshacerCanje: deshacerCanje, pendientes: pendientes, todosLosCanjes: todosLosCanjes, construirCanjes: construirCanjes, marcarEnviados: marcarEnviados,
  };
  if (typeof module === 'object' && module.exports) module.exports = api; else raiz.Surtidor = api;
})(typeof window !== 'undefined' ? window : this);
