// Pruebas del núcleo de «Surtidor Faustino». Se corren con:  node prueba/prueba.js
// Usan un archivo de cupones activos REAL generado por el sistema del hospital (prueba/lote-ejemplo.json, con datos ficticios), así que comprueban de verdad que la firma
// Ed25519 hecha con libsodium (PHP) se verifica con tweetnacl y que las pruebas de canje coinciden con las que recalcula el sistema.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nacl = require('../app/src/main/assets/nacl.min.js');
const S = require('../app/src/main/assets/nucleo.js');

const texto = fs.readFileSync(path.join(__dirname, 'lote-ejemplo.json'), 'utf8');
const dia = (s) => new Date(s + 'T10:00:00'); // hora local del teléfono

let n = 0;
async function prueba(nombre, f) {
  try { await f(); n++; console.log('  ok  ' + nombre); } catch (e) { console.error('FALLA ' + nombre + '\n', e); process.exitCode = 1; }
}

(async () => {
  console.log('Núcleo de Surtidor Faustino');

  await prueba('verifica la firma del archivo real del sistema', () => {
    const r = S.verificarLote(texto, nacl);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.datos.lote, '2026-11-12-1');
    assert.equal(r.datos.cupones.length, 4);
    assert.equal(r.datos.semana_inicio, '2026-11-12');
    assert.equal(r.datos.semana_fin, '2026-11-18');
  });

  await prueba('rechaza un archivo alterado (cambia un dato)', () => {
    const doc = JSON.parse(texto);
    doc.datos = doc.datos.replace('"litros":40', '"litros":99');
    const r = S.verificarLote(JSON.stringify(doc), nacl);
    assert.equal(r.ok, false);
    assert.match(r.error, /firma/);
  });

  await prueba('rechaza una firma de otro origen y los archivos que no son del hospital', () => {
    const doc = JSON.parse(texto);
    const otro = nacl.sign.keyPair();
    const datos = doc.datos;
    const firma = Buffer.from(nacl.sign.detached(new TextEncoder().encode(datos), otro.secretKey)).toString('base64');
    // Firma válida pero con OTRA llave dentro del archivo: la firma se verifica, pero la llave no es la fijada (lo decide la pantalla comparando la huella).
    const r = S.verificarLote(JSON.stringify({ ...doc, firma, clave: Buffer.from(otro.publicKey).toString('base64') }), nacl);
    assert.equal(r.ok, true);
    assert.notEqual(r.clave, doc.clave);
    assert.equal(S.verificarLote('esto no es json', nacl).ok, false);
    assert.equal(S.verificarLote('{"formato":"otro"}', nacl).ok, false);
    assert.equal(S.verificarLote(JSON.stringify({ ...doc, firma: 'AAAA' }), nacl).ok, false);
  });

  await prueba('la huella de la llave tiene el formato que muestra el sistema', async () => {
    const h = await S.huella(JSON.parse(texto).clave);
    assert.match(h, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    assert.equal(h, 'C739-08AC-F4E3-E71D'); // la que imprimió el sistema al generar el archivo de ejemplo
  });

  await prueba('lee el QR del cupón y rechaza lo que no es uno', () => {
    assert.deepEqual(S.leerQr('SGHC1:COMB-2026-00008:CTA9N-W6RVH'), { folio: 'COMB-2026-00008', codigo: 'CTA9N-W6RVH' });
    assert.deepEqual(S.leerQr('  SGHC1:COMB-2026-00008:CTA9N-W6RVH\n'), { folio: 'COMB-2026-00008', codigo: 'CTA9N-W6RVH' });
    for (const malo of ['', 'https://ejemplo.cu', 'SGHC2:COMB-2026-00008:CTA9N-W6RVH', 'SGHC1:COMB-26-8:CTA9N-W6RVH', 'SGHC1:COMB-2026-00008', 'SGHC1:COMB-2026-00008:abc']) {
      assert.equal(S.leerQr(malo), null, malo);
    }
  });

  await prueba('normaliza el folio y el código escritos a mano', () => {
    assert.equal(S.normalizarFolio('8', dia('2026-11-12')), 'COMB-2026-00008');
    assert.equal(S.normalizarFolio('2026-8'), 'COMB-2026-00008');
    assert.equal(S.normalizarFolio('comb-2026-00008'), 'COMB-2026-00008');
    assert.equal(S.normalizarCodigo(' cta9n w6rvh '), 'CTA9N-W6RVH');
    assert.equal(S.normalizarCodigo('CTA9NW6RVH'), 'CTA9N-W6RVH');
  });

  const estado = S.estadoNuevo();
  const lote = S.verificarLote(texto, nacl);
  const r = S.integrarLote(estado, lote.datos, dia('2026-11-12'));

  await prueba('integra el archivo: 4 cupones nuevos', () => {
    assert.equal(r.nuevos, 4);
    assert.equal(Object.keys(estado.cupones).length, 4);
    assert.equal(estado.cupones['COMB-2026-00008'].codigo, 'CTA9N-W6RVH');
    assert.equal(estado.cupones['COMB-2026-00008'].canje, null);
  });

  await prueba('evalúa: válido dentro de la semana, fuera de semana antes y después', () => {
    assert.equal(S.evaluar(estado, 'COMB-2026-00008', 'CTA9N-W6RVH', dia('2026-11-13')).resultado, 'valido');
    assert.equal(S.evaluar(estado, 'COMB-2026-00008', 'CTA9N-W6RVH', dia('2026-11-12')).resultado, 'valido');
    assert.equal(S.evaluar(estado, 'COMB-2026-00008', 'CTA9N-W6RVH', dia('2026-11-18')).resultado, 'valido');
    const antes = S.evaluar(estado, 'COMB-2026-00008', 'CTA9N-W6RVH', dia('2026-11-11'));
    assert.equal(antes.resultado, 'fuera_de_semana'); assert.equal(antes.antes, true);
    const despues = S.evaluar(estado, 'COMB-2026-00008', 'CTA9N-W6RVH', dia('2026-11-19'));
    assert.equal(despues.resultado, 'fuera_de_semana'); assert.equal(despues.antes, false);
  });

  await prueba('un código que no coincide o un cupón que no está no valen y no revelan datos', () => {
    const mal = S.evaluar(estado, 'COMB-2026-00008', 'AAAAA-BBBBB', dia('2026-11-13'));
    assert.equal(mal.resultado, 'codigo_no_coincide'); assert.equal(mal.cupon, null);
    const no = S.evaluar(estado, 'COMB-2026-09999', 'AAAAA-BBBBB', dia('2026-11-13'));
    assert.equal(no.resultado, 'no_esta'); assert.equal(no.cupon, null);
  });

  let canje;
  await prueba('canjear guarda la fecha y la prueba, y ya no vale otra vez', async () => {
    canje = await S.canjear(estado, 'COMB-2026-00008', dia('2026-11-13'));
    assert.match(canje.fecha, /^2026-11-13T10:00:00[+-]\d\d:\d\d$/);
    assert.equal(canje.prueba.length, 20);
    assert.equal(canje.exportado, false);
    assert.equal(S.evaluar(estado, 'COMB-2026-00008', 'CTA9N-W6RVH', dia('2026-11-13')).resultado, 'canjeado');
    await assert.rejects(() => S.canjear(estado, 'COMB-2026-00008', dia('2026-11-13')), /ya estaba canjeado/);
  });

  await prueba('la prueba es HMAC-SHA256 con el código como llave (igual que el sistema)', async () => {
    const nodeCrypto = require('node:crypto');
    const esperado = nodeCrypto.createHmac('sha256', 'CTA9NW6RVH').update('COMB-2026-00008|' + canje.fecha + '|2026-11-12-1').digest('hex').slice(0, 20);
    assert.equal(canje.prueba, esperado);
  });

  await prueba('el archivo de canjes lleva solo lo pendiente y se puede deshacer antes de enviarlo', async () => {
    await S.canjear(estado, 'COMB-2026-00010', dia('2026-11-14'));
    estado.expendedor = 'Pedro Pablo Linares';
    const a = S.construirCanjes(estado, dia('2026-11-14'));
    assert.equal(a.formato, 'SGHC-CANJES-1');
    assert.equal(a.lote, '2026-11-12-1');
    assert.equal(a.expendedor, 'Pedro Pablo Linares');
    assert.deepEqual(a.canjes.map((c) => c.folio), ['COMB-2026-00008', 'COMB-2026-00010']);
    assert.deepEqual(Object.keys(a.canjes[0]).sort(), ['fecha', 'folio', 'lote', 'prueba']);
    if (process.env.SALIDA_CANJES) fs.writeFileSync(process.env.SALIDA_CANJES, JSON.stringify(a)); // para comprobarlo contra el sistema (PHP)

    S.deshacerCanje(estado, 'COMB-2026-00010');
    assert.equal(S.pendientes(estado).length, 1);
    S.marcarEnviados(estado, a.canjes);
    assert.equal(S.pendientes(estado).length, 0);
    assert.throws(() => S.deshacerCanje(estado, 'COMB-2026-00008'), /ya se envió/);
    assert.equal(S.construirCanjes(estado, dia('2026-11-14')).canjes.length, 0);
    assert.equal(S.construirCanjes(estado, dia('2026-11-14'), true).canjes.length, 1, 'Reenviar todo es posible.');
  });

  await prueba('cargar otro archivo conserva los canjes ya hechos y poda lo viejo ya enviado', () => {
    const otro = JSON.parse(JSON.stringify(lote.datos));
    otro.lote = '2026-11-12-2';
    S.integrarLote(estado, otro, dia('2026-11-14'));
    assert.notEqual(estado.cupones['COMB-2026-00008'].canje, null, 'Conserva el canje.');
    assert.equal(estado.cupones['COMB-2026-00008'].lote, '2026-11-12-2');
    // Un mes y medio después: el canje enviado de esa semana se poda.
    S.integrarLote(estado, { ...otro, lote: '2026-12-31-1', semana_inicio: '2026-12-31', semana_fin: '2027-01-06', cupones: [] }, dia('2026-12-31'));
    assert.equal(estado.cupones['COMB-2026-00008'], undefined);
  });

  console.log(n + ' pruebas pasaron');
})();
