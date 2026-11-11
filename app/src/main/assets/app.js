/* Surtidor Faustino — pantallas. La lógica está en nucleo.js; aquí solo se maneja la interfaz. Todo funciona sin conexión. */
(function () {
  'use strict';
  var S = window.Surtidor;
  var CLAVE = 'sgh-surtidor-estado';
  var VERSION = '1.0';
  var estado = leer();
  var vista = 'inicio';
  var flujo = null;       // el cupón que se está viendo { folio, codigo }
  var enviarTodos = false;
  var camara = { stream: null, activa: false };

  function $(id) { return document.getElementById(id); }

  /* ---------- almacenamiento ---------- */
  function leer() {
    try { var e = JSON.parse(localStorage.getItem(CLAVE)); if (e && e.version === 1) return e; } catch (x) { /* empieza vacío */ }
    return S.estadoNuevo();
  }
  function guardar() { try { localStorage.setItem(CLAVE, JSON.stringify(estado)); } catch (x) { avisar('No se pudo guardar en el teléfono.'); } }

  /* ---------- utilidades de pantalla ---------- */
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function litros(n) { return String(Number(n)).replace('.', ','); }
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function corta(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? Number(m[3]) + ' ' + MESES[Number(m[2]) - 1] : '—'; }
  function cuando(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || ''); return m ? Number(m[3]) + ' ' + MESES[Number(m[2]) - 1] + ' ' + m[4] + ':' + m[5] : '—'; }

  var tAviso = null;
  function avisar(texto) {
    var a = $('aviso'); a.textContent = texto; a.hidden = false;
    clearTimeout(tAviso); tAviso = setTimeout(function () { a.hidden = true; }, 3200);
  }

  /** Ventana de confirmación; devuelve una promesa con true/false. Con `soloAceptar` no hay botón de cancelar. */
  function confirmar(titulo, texto, si, no, soloAceptar) {
    return new Promise(function (resolver) {
      $('m-titulo').textContent = titulo; $('m-texto').textContent = texto;
      $('m-si').textContent = si || 'Aceptar'; $('m-no').textContent = no || 'Cancelar'; $('m-no').hidden = !!soloAceptar;
      $('modal').hidden = false;
      function cerrar(v) { $('modal').hidden = true; $('m-si').onclick = null; $('m-no').onclick = null; resolver(v); }
      $('m-si').onclick = function () { cerrar(true); }; $('m-no').onclick = function () { cerrar(false); };
    });
  }

  function ir(nombre) {
    if (nombre !== 'escaner') detenerCamara();
    ['inicio', 'escaner', 'teclear', 'resultado', 'canjes', 'ajustes'].forEach(function (v) { $('v-' + v).hidden = (v !== nombre); });
    vista = nombre;
    window.scrollTo(0, 0);
    if (nombre === 'inicio') pintarInicio();
    if (nombre === 'canjes') pintarCanjes();
    if (nombre === 'ajustes') pintarAjustes();
  }

  /** El botón «atrás» de Android: devuelve true si la aplicación lo atendió. */
  window.atras = function () {
    if (!$('modal').hidden) return true;
    if (vista === 'inicio') return false;
    ir('inicio');
    return true;
  };

  /* ---------- inicio ---------- */
  function pintarInicio() {
    var cupones = Object.keys(estado.cupones).map(function (f) { return estado.cupones[f]; });
    var hoy = S.fechaLocal(new Date());
    var lotes = Object.keys(estado.lotes).sort();
    var ultimo = lotes.length ? estado.lotes[lotes[lotes.length - 1]] : null;
    $('hospital').textContent = (ultimo && ultimo.hospital) || 'Validación de cupones de combustible';
    var sinCanjear = cupones.filter(function (c) { return !c.canje; });
    var vigentes = sinCanjear.filter(function (c) { return hoy >= c.desde && hoy <= c.hasta; });
    var porEnviar = S.pendientes(estado).length;
    var h = '';
    if (!cupones.length) {
      h = 'Todavía no tienes cupones cargados.<br>Pídele a la Dirección el <b>archivo de cupones</b> y toca «Cargar cupones».';
    } else {
      h = '<b>' + vigentes.length + '</b> cupón(es) vigentes hoy · <b>' + sinCanjear.length + '</b> sin canjear · <b>' + porEnviar + '</b> canje(s) por enviar';
      if (ultimo) h += '<br>Archivo <b>' + esc(lotes[lotes.length - 1]) + '</b> · semana del ' + corta(ultimo.desde) + ' al ' + corta(ultimo.hasta);
      if (!vigentes.length && sinCanjear.length) h += '<span class="alerta">Ninguno de tus cupones vale hoy: pide un archivo nuevo a la Dirección.</span>';
      if (ultimo && ultimo.generado && new Date().getTime() < new Date(ultimo.generado).getTime() - 86400000) h += '<span class="alerta">La fecha del teléfono parece estar atrasada. Corrígela en Ajustes del teléfono.</span>';
    }
    $('estado').innerHTML = h;
    $('n-canjes').textContent = porEnviar ? 'Canjes (' + porEnviar + ' por enviar)' : 'Canjes';
  }

  /* ---------- cargar el archivo de cupones ---------- */
  function leerArchivo(archivo) {
    if (archivo.text) return archivo.text();
    return new Promise(function (ok, mal) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = mal; r.readAsText(archivo); });
  }

  async function cargarLote(archivo) {
    var texto;
    try { texto = await leerArchivo(archivo); } catch (e) { await confirmar('No se pudo leer', 'No se pudo abrir el archivo.', 'Aceptar', null, true); return; }
    var r = S.verificarLote(texto, window.nacl);
    if (!r.ok) { await confirmar('Archivo no válido', r.error, 'Aceptar', null, true); return; }
    if (estado.clavePublica && estado.clavePublica !== r.clave) {
      await confirmar('Archivo de otro origen', 'Este archivo no viene del hospital con el que emparejaste este teléfono (la llave no coincide). No se cargó.', 'Aceptar', null, true);
      return;
    }
    if (!estado.clavePublica) {
      var hu = await S.huella(r.clave);
      var ok = await confirmar('Emparejar con el hospital',
        'Es la primera vez que cargas un archivo.\n\nHuella de la llave:\n' + hu + '\n\nConfirma con la Dirección que es la misma que muestra el sistema en Combustible → Expendedor. Desde ahora solo se aceptarán archivos con esta llave.',
        'Es la misma', 'No sé');
      if (!ok) return;
      estado.clavePublica = r.clave; estado.huella = hu;
    }
    var res = S.integrarLote(estado, r.datos, new Date());
    guardar();
    pintarInicio();
    avisar('Archivo cargado: ' + res.total + ' cupón(es), ' + res.nuevos + ' nuevo(s).');
  }

  /* ---------- resultado de un cupón ---------- */
  function mostrarResultado(folio, codigo, recien) {
    flujo = { folio: folio, codigo: codigo };
    var ev = S.evaluar(estado, folio, codigo, new Date());
    var c = ev.cupon;
    var cabeza = { valido: ['verde', '✅', 'Cupón válido', 'Puedes entregar el combustible.'], canjeado: ['rojo', '⛔', 'Ya se canjeó', 'No lo entregues otra vez.'],
      fuera_de_semana: ['ambar', '⌛', 'Fuera de semana', ''], codigo_no_coincide: ['rojo', '🚫', 'Código no coincide', 'Puede ser falso o estar alterado. No entregues combustible.'],
      no_esta: ['rojo', '🚫', 'No está en tus cupones', 'Este cupón no está en el archivo que cargaste: puede ser falso o de otra semana. Pide a la Dirección un archivo nuevo.'] }[ev.resultado];
    if (ev.resultado === 'canjeado') cabeza[3] = 'Se canjeó el ' + cuando(c.canje.fecha) + '. No lo entregues otra vez.';
    if (ev.resultado === 'canjeado' && recien) cabeza = ['verde', '✔', 'Canje guardado', 'Quedó registrado: este cupón ya no vale otra vez. Al terminar, envía el archivo de canjes a la Dirección.'];
    if (ev.resultado === 'fuera_de_semana') cabeza[3] = 'Este cupón vale del ' + corta(c.desde) + ' al ' + corta(c.hasta) + (ev.antes ? ' y todavía no es su semana.' : ' y ya venció.');
    var h = '<div class="res ' + cabeza[0] + '"><div class="gr"><span class="ico">' + cabeza[1] + '</span><div><h3>' + cabeza[2] + '</h3><p>' + esc(cabeza[3]) + '</p></div></div>';
    if (c) {
      h += '<div class="datos"><div class="ancho"><span class="k">Chofer</span><span class="v">' + esc(c.chofer) + '</span></div>' +
        '<div><span class="k">Matrícula</span><span class="v"><span class="chapa">' + esc(c.matricula) + '</span></span></div>' +
        '<div><span class="k">Combustible</span><span class="v">' + esc(c.tipo) + '</span></div>' +
        '<div><span class="k">Litros</span><span class="v" style="font-size:30px">' + litros(c.litros) + ' L</span></div>' +
        '<div><span class="k">Folio</span><span class="v" style="font-size:15px">' + esc(c.folio) + '</span></div>' +
        (c.dias && c.dias !== '—' ? '<div class="ancho"><span class="k">Días de abastecimiento</span><span class="v" style="font-size:16px">' + esc(c.dias) + '</span></div>' : '') + '</div>';
    }
    $('resultado').innerHTML = h + '</div>';
    $('b-entregado').hidden = ev.resultado !== 'valido';
    ir('resultado');
  }

  async function entregar() {
    if (!flujo) return;
    var ev = S.evaluar(estado, flujo.folio, flujo.codigo, new Date());
    if (ev.resultado !== 'valido') { mostrarResultado(flujo.folio, flujo.codigo); return; }
    var c = ev.cupon;
    var ok = await confirmar('Entregar el combustible', litros(c.litros) + ' litros de ' + c.tipo + ' a ' + c.chofer + ' (' + c.matricula + ').\n\n¿Ya entregaste el combustible y lo marcas como canjeado?', 'Sí, canjear', 'Todavía no');
    if (!ok) return;
    try { await S.canjear(estado, c.folio, new Date()); } catch (e) { avisar(e.message); return; }
    guardar();
    mostrarResultado(flujo.folio, flujo.codigo, true);
  }

  /* ---------- cámara y QR ---------- */
  function detenerCamara() {
    camara.activa = false;
    if (camara.stream) { camara.stream.getTracks().forEach(function (t) { t.stop(); }); camara.stream = null; }
    var v = $('video'); if (v) v.srcObject = null;
  }

  async function escanear() {
    ir('escaner');
    $('ayuda-escaner').textContent = 'Apunta la cámara al código QR del cupón.';
    try {
      camara.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (e) {
      $('ayuda-escaner').textContent = 'No se pudo abrir la cámara. Usa «Leer el QR de una foto» o teclea el folio y el código.';
      return;
    }
    var video = $('video'); video.srcObject = camara.stream;
    try { await video.play(); } catch (e) { /* algunos teléfonos reproducen solos */ }
    camara.activa = true;
    var lienzo = document.createElement('canvas'); var ctx = lienzo.getContext('2d', { willReadFrequently: true });
    (function tick() {
      if (!camara.activa || vista !== 'escaner') return;
      if (video.readyState >= 2 && video.videoWidth) {
        var w = Math.min(800, video.videoWidth); var h = Math.round(video.videoHeight * w / video.videoWidth);
        lienzo.width = w; lienzo.height = h; ctx.drawImage(video, 0, 0, w, h);
        var img = ctx.getImageData(0, 0, w, h);
        var q = window.jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (q) {
          var d = S.leerQr(q.data);
          if (d) { if (navigator.vibrate) navigator.vibrate(60); detenerCamara(); mostrarResultado(d.folio, d.codigo); return; }
          $('ayuda-escaner').textContent = 'Ese código no es de un cupón de combustible.';
        }
      }
      setTimeout(tick, 110);
    })();
  }

  /** Lee el QR de una foto de la galería (por si la cámara en vivo falla o el cupón está arrugado). */
  function leerFoto(archivo) {
    var url = URL.createObjectURL(archivo); var im = new Image();
    im.onload = function () {
      var encontrado = null;
      [1600, 1000, 2400, 700].forEach(function (max) {
        if (encontrado) return;
        var esc2 = Math.min(1, max / Math.max(im.width, im.height)); var w = Math.round(im.width * esc2), h = Math.round(im.height * esc2);
        var l = document.createElement('canvas'); l.width = w; l.height = h; var x = l.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, w, h);
        var q = window.jsQR(x.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
        if (q) encontrado = S.leerQr(q.data);
      });
      URL.revokeObjectURL(url);
      if (encontrado) mostrarResultado(encontrado.folio, encontrado.codigo);
      else avisar('No se encontró un QR de cupón en la foto. Prueba con otra foto o teclea el folio y el código.');
    };
    im.onerror = function () { avisar('No se pudo abrir la foto.'); };
    im.src = url;
  }

  /* ---------- canjes ---------- */
  function pintarCanjes() {
    var todos = S.todosLosCanjes(estado); var pend = S.pendientes(estado);
    $('resumen-canjes').textContent = todos.length ? (pend.length + ' canje(s) por enviar de ' + todos.length + ' en total.') : 'Todavía no has canjeado ningún cupón.';
    var h = '';
    todos.forEach(function (c) {
      h += '<div class="canje"><div class="f"><b>' + esc(c.chofer) + '</b><span class="etq ' + (c.canje.exportado ? 'env">Enviado' : 'pend">Por enviar') + '</span></div>' +
        '<span>' + esc(c.matricula) + ' · ' + litros(c.litros) + ' L · ' + esc(c.tipo) + '</span><span style="color:var(--suave);font-size:13px">' + esc(c.folio) + ' · ' + cuando(c.canje.fecha) + '</span>' +
        (c.canje.exportado ? '' : '<button data-deshacer="' + esc(c.folio) + '">Deshacer este canje</button>') + '</div>';
    });
    $('lista-canjes').innerHTML = h;
    $('b-compartir').disabled = $('b-guardar').disabled = false;
  }

  function archivoDeCanjes() {
    var ahora = new Date();
    var doc = S.construirCanjes(estado, ahora, enviarTodos);
    if (!doc.canjes.length) { avisar(enviarTodos ? 'No hay canjes.' : 'No hay canjes nuevos para enviar.'); return null; }
    function p(n) { return ('0' + n).slice(-2); }
    var nombre = 'canjes-combustible-' + ahora.getFullYear() + '-' + p(ahora.getMonth() + 1) + '-' + p(ahora.getDate()) + '-' + p(ahora.getHours()) + p(ahora.getMinutes()) + '.json';
    return { doc: doc, nombre: nombre, texto: JSON.stringify(doc) };
  }

  async function enviarCanjes(modo) {
    if (!estado.expendedor) {
      var ok = await confirmar('Tu nombre', 'El archivo de canjes lleva tu nombre. Escríbelo en Ajustes antes de enviarlo.', 'Ir a Ajustes', 'Enviar sin nombre');
      if (ok) { ir('ajustes'); return; }
    }
    var a = archivoDeCanjes(); if (!a) return;
    if (window.AndroidSurtidor) {
      if (modo === 'compartir') window.AndroidSurtidor.compartir(a.nombre, a.texto); else window.AndroidSurtidor.guardar(a.nombre, a.texto);
    } else {
      var blob = new Blob([a.texto], { type: 'application/json' }); var enlace = document.createElement('a');
      enlace.href = URL.createObjectURL(blob); enlace.download = a.nombre; document.body.appendChild(enlace); enlace.click(); enlace.remove();
    }
    var enviado = await confirmar('¿Ya lo enviaste?', 'Cuando le hayas mandado el archivo a la Dirección, toca «Sí, ya lo envié» para marcar estos canjes como enviados. Si no, toca «Todavía no» y podrás enviarlo otra vez.', 'Sí, ya lo envié', 'Todavía no');
    if (enviado) { S.marcarEnviados(estado, a.doc.canjes); enviarTodos = false; guardar(); pintarCanjes(); avisar('Canjes marcados como enviados.'); }
  }

  /* ---------- ajustes ---------- */
  function pintarAjustes() {
    $('a-nombre').value = estado.expendedor || '';
    $('a-huella').textContent = estado.huella || 'Todavía no has cargado ningún archivo de cupones.';
    $('a-hora').textContent = new Date().toLocaleString('es');
    $('version').textContent = 'Surtidor Faustino ' + VERSION + ' · funciona sin conexión';
  }

  /* ---------- eventos ---------- */
  $('b-escanear').onclick = escanear;
  $('b-cancelar-escaner').onclick = function () { ir('inicio'); };
  $('b-teclear').onclick = function () { $('t-folio').value = ''; $('t-codigo').value = ''; ir('teclear'); $('t-folio').focus(); };
  $('b-cancelar-teclear').onclick = function () { ir('inicio'); };
  $('b-comprobar').onclick = function () {
    var folio = S.normalizarFolio($('t-folio').value, new Date()); var codigo = S.normalizarCodigo($('t-codigo').value);
    if (!folio || !codigo) { avisar('Escribe el folio y el código del cupón.'); return; }
    mostrarResultado(folio, codigo);
  };
  $('b-foto').onclick = function () { $('f-foto').value = ''; $('f-foto').click(); };
  $('f-foto').onchange = function () { if (this.files && this.files[0]) leerFoto(this.files[0]); };
  $('b-cargar').onclick = function () { $('f-lote').value = ''; $('f-lote').click(); };
  $('f-lote').onchange = function () { if (this.files && this.files[0]) cargarLote(this.files[0]); };
  $('b-entregado').onclick = entregar;
  $('b-siguiente').onclick = function () { flujo = null; ir('inicio'); };
  $('b-canjes').onclick = function () { ir('canjes'); };
  $('b-volver-canjes').onclick = function () { ir('inicio'); };
  $('b-compartir').onclick = function () { enviarCanjes('compartir'); };
  $('b-guardar').onclick = function () { enviarCanjes('guardar'); };
  $('b-reenviar').onclick = function () { enviarTodos = true; avisar('El próximo envío incluirá todos los canjes, también los ya enviados.'); };
  $('lista-canjes').onclick = async function (e) {
    var f = e.target && e.target.getAttribute && e.target.getAttribute('data-deshacer'); if (!f) return;
    var c = estado.cupones[f];
    var ok = await confirmar('Deshacer el canje', 'El cupón de ' + (c ? c.chofer : f) + ' volverá a quedar sin canjear. Úsalo solo si lo marcaste por equivocación.', 'Deshacer', 'Cancelar');
    if (!ok) return;
    try { S.deshacerCanje(estado, f); guardar(); pintarCanjes(); } catch (x) { avisar(x.message); }
  };
  $('b-ajustes').onclick = function () { ir('ajustes'); };
  $('b-volver-ajustes').onclick = function () { estado.expendedor = $('a-nombre').value.trim(); guardar(); ir('inicio'); };
  $('a-nombre').onchange = function () { estado.expendedor = this.value.trim(); guardar(); };
  $('b-borrar').onclick = async function () {
    var ok = await confirmar('Borrar todo', 'Se borrarán los cupones, los canjes y el emparejamiento con el hospital de este teléfono. Si hay canjes sin enviar, se perderán.\n\n¿Seguro?', 'Borrar todo', 'Cancelar');
    if (!ok) return;
    try { localStorage.removeItem(CLAVE); } catch (e) { /* nada */ }
    estado = S.estadoNuevo(); ir('inicio'); avisar('Datos borrados.');
  };

  ir('inicio');
})();
