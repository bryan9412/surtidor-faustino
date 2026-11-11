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

  function subtle() {
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || raiz.crypto;
    if (!c || !c.subtle) throw new Error('Este teléfono no permite calcular las pruebas (falta WebCrypto).');
    return c.subtle;
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
    var h = aHex(new Uint8Array(await subtle().digest('SHA-256', deBase64(clavePublicaBase64)))).toUpperCase().slice(0, 16);
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
    var llave = await subtle().importKey('raw', utf8(String(codigo).toUpperCase().replace(/-/g, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var firma = await subtle().sign('HMAC', llave, utf8(folio + '|' + fecha + '|' + lote));
    return aHex(new Uint8Array(firma)).slice(0, 20);
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
    FORMATO_LOTE: FORMATO_LOTE, FORMATO_CANJES: FORMATO_CANJES, huella: huella, normalizarCodigo: normalizarCodigo, normalizarFolio: normalizarFolio, leerQr: leerQr,
    isoLocal: isoLocal, fechaLocal: fechaLocal, prueba: prueba, estadoNuevo: estadoNuevo, verificarLote: verificarLote, integrarLote: integrarLote, evaluar: evaluar,
    canjear: canjear, deshacerCanje: deshacerCanje, pendientes: pendientes, todosLosCanjes: todosLosCanjes, construirCanjes: construirCanjes, marcarEnviados: marcarEnviados,
  };
  if (typeof module === 'object' && module.exports) module.exports = api; else raiz.Surtidor = api;
})(typeof window !== 'undefined' ? window : this);
