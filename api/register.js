// Registro de pilotos, locales, flotistas y usuarios de DragoExpres.
// Los registros (datos personales) se guardan en el repo PRIVADO de datos,
// rama 'dragoexpres-data', archivo registros.json — nunca en repos publicos.
const wrap = require('./_cors');
const { usaDb, dbGet, dbPut } = require('./_db');
const { REPO, BRANCH, TOKEN, H, ensureBranch, normalizar } = require('./_dx');
const PATH = 'registros.json';
const { pushA } = require('./_push');
async function ghGetPath(path) {
  if (usaDb) return dbGet(path);
  await ensureBranch();
  const rr = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`, { headers: H() });
  if (!rr.ok) return null;
  const j = await rr.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}

async function avisoFotos(docs, titulo) {
  try {
    const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID || '8022768138';
    if (!tok || !Array.isArray(docs) || !docs.length) return;
    const REPOD = process.env.GITHUB_DATA_REPO || 'juanca42003177-oss/dragon-labs-data';
    const nombres = { selfie: 'Selfie', dpi: 'DPI FRENTE', dpiReverso: 'DPI REVERSO', licencia: 'Licencia', mochila: 'CAJA TÉRMICA' };
    const media = []; const archivos = [];
    const lista = docs.slice(0, 8);
    for (let i = 0; i < lista.length; i++) {
      const dd = lista[i] || {};
      if (!dd.archivo) continue;
      const r = await fetch(`https://api.github.com/repos/${REPOD}/contents/dragoexpres/${dd.archivo}?ref=dragoexpres-data`, { headers: { Authorization: 'Bearer ' + (process.env.GITHUB_TOKEN || ''), Accept: 'application/vnd.github+json' } });
      if (!r.ok) continue;
      const j = await r.json();
      const bytes = Buffer.from(j.content || '', 'base64');
      if (!bytes.length) continue;
      const fname = 'foto' + i + '.jpg';
      archivos.push({ fname, bytes });
      media.push({ type: 'photo', media: 'attach://' + fname, caption: (nombres[dd.tipo] || dd.tipo) + ' — ' + titulo });
    }
    if (!media.length) return;
    const fd = new FormData();
    fd.append('chat_id', chat);
    fd.append('media', JSON.stringify(media));
    archivos.forEach(a => fd.append(a.fname, new Blob([a.bytes], { type: 'image/jpeg' }), a.fname));
    await fetch(`https://api.telegram.org/bot${tok}/sendMediaGroup`, { method: 'POST', body: fd });
  } catch (e) { }
}
async function aviso(texto) {
  try {
    const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID || '8022768138';
    if (!tok) return;
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: texto })
    });
  } catch (e) { }
}
let cache = null;

async function ghGet() {
  if (usaDb) return dbGet(PATH);
  await ensureBranch();
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${BRANCH}`, { headers: H() });
  if (!r.ok) return null;
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}
async function ghPut(sha, data) {
  if (usaDb) return dbPut(PATH, sha, data, 'registro nuevo');
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, {
    method: 'PUT',
    headers: { ...H(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'registro nuevo', branch: BRANCH, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'), sha: sha || undefined }),
  });
  if (!r.ok) throw new Error('guardar HTTP ' + r.status);
}

module.exports = wrap(async (req, res) => {
  const now = Date.now();
  if (req.query && req.query.stats) {
    let stats = { pilotos: 0, locales: 0, flota: 0 };
    if (cache && now - cache.ts < 60000) stats = cache.stats;
    else {
      const f = await ghGet();
      if (f) {
        stats = { pilotos: f.data.filter(r => r.tipo === 'piloto').length, locales: f.data.filter(r => r.tipo === 'local').length, flota: f.data.filter(r => r.tipo === 'flota').length };
        cache = { ts: now, stats };
      }
    }
    return res.status(200).json({ ok: true, stats: stats, pilotos: stats.pilotos, locales: stats.locales, flota: stats.flota });
  }
  const d = normalizar(req.body);
  // zona OPCIONAL desde 2026-10-23: el usuario solo da su direccion, los pedidos los ven todos los pilotos
  if (!d.tipo || !d.nombre || !d.tel) {
    return res.status(200).json({ ok: false, error: 'Faltan datos: nombre y WhatsApp son obligatorios.' });
  }
  const f = await ghGet();
  const data = f ? f.data : [];
  // VERIFICACION AUTOMATICA de asociados (motos, carros, bicicletas) y usuarios
  const checks = [];
  const limpiar = (q) => String(q || '').replace(/\D/g, '');
  if ((d.tipo === 'piloto' || d.tipo === 'local') && d.contrato !== true) return res.status(200).json({ ok: false, error: 'Para registrarte tenés que aceptar el Contrato Digital de DragoExpres.' });
  // UN NUMERO = UNA IDENTIDAD: el mismo WhatsApp no puede tener dos roles distintos (piloto/local/flota).
  // Los rechazados por falta de DPI pueden re-registrarse; los usuarios (clientes) no bloquean.
  if (d.tipo === 'piloto' || d.tipo === 'local' || d.tipo === 'flota') {
    const rolTxt = { piloto: 'PILOTO', local: 'LOCAL', flota: 'FLOTISTA' };
    const otro = data.find(r2 => r2.estado !== 'rechazado_falta_dpi' && ['piloto', 'local', 'flota'].includes(r2.tipo) && limpiar((r2.datos || {}).tel) === limpiar(d.tel));
    if (otro && otro.tipo === d.tipo) return res.status(200).json({ ok: false, error: 'Ese WhatsApp ya está registrado como ' + rolTxt[d.tipo] + '. No hace falta registrarte otra vez: entrá directo a tu panel con ese número.' });
    if (otro) return res.status(200).json({ ok: false, error: 'Ese WhatsApp ya está registrado como ' + rolTxt[otro.tipo] + ' en DragoExpres. Cada número es una sola identidad: para este rol usá otro número de WhatsApp.' });
  }
  let dpiRechazado = false;
  if (d.tipo === 'piloto') {
    const dpiOk = limpiar(d.dpi).length === 13;
    checks.push({ k: 'DPI', ok: dpiOk, txt: dpiOk ? 'DPI de 13 dígitos' : 'DPI incompleto (' + limpiar(d.dpi).length + '/13)' });
    const esBici = d.vehiculo === 'bicicleta';
    const enTramite = d.licenciaEnTramite === true;
    const tieneDpiF = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'dpi');
    const tieneDpiR = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'dpiReverso');
    const tieneSelfie = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'selfie');
    const tieneLic = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'licencia');
    if (!tieneDpiF || !tieneDpiR) dpiRechazado = true;
    const docsOk = tieneDpiF && tieneDpiR && tieneSelfie && (esBici || tieneLic || enTramite);
    checks.push({ k: 'FOTOS', ok: docsOk, txt: 'DPI frente' + (tieneDpiF ? '✅' : '❌') + ' + reverso' + (tieneDpiR ? '✅' : '❌') + ' + selfie' + (tieneSelfie ? '✅' : '❌') + (esBici ? ' (bicicleta: sin licencia)' : (enTramite && !tieneLic ? ' + licencia en trámite 📜' : ' + licencia' + (tieneLic ? '✅' : '❌'))) });
    if (!esBici) checks.push({ k: 'LICENCIA', ok: (tieneLic || enTramite), txt: (tieneLic ? 'Foto de licencia recibida' : (enTramite ? '📜 EN TRÁMITE — pide tu OK para trabajar mientras la tramita' : 'Falta la foto de la licencia')) });
    const tieneMochila = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'mochila');
    // La caja termica solo se exige a quien reparte comida o repuestos.
    // El piloto de moto/carro que SOLO hace viajes de personas no la necesita.
    const soloViajes = Array.isArray(d.servicios) && d.servicios.length > 0 && d.servicios.every(sv => sv === 'viajes');
    const necesitaCaja = !(soloViajes && !esBici);
    checks.push({ k: 'MOCHILA', ok: (necesitaCaja ? tieneMochila : true), txt: (!necesitaCaja ? 'Solo viajes de personas: no necesita caja térmica' : (tieneMochila ? 'Foto RECIBIDA 📦 (confirmá en las fotos de Telegram que sea una caja real)' : 'FALTA foto de la caja térmica (obligatoria para repartir comida o repuestos)')) });
    if (!esBici) { const placaOk = /^[A-Z0-9-]{5,10}$/i.test(String(d.placa || '')); checks.push({ k: 'PLACA', ok: placaOk, txt: placaOk ? 'Placa válida: ' + d.placa : 'Placa inválida' }); }
    const dup = data.some(r2 => r2.tipo === 'piloto' && (limpiar((r2.datos || {}).tel) === limpiar(d.tel) || (d.placa && String((r2.datos || {}).placa || '').toUpperCase() === String(d.placa).toUpperCase())));
    checks.push({ k: 'ÚNICO', ok: !dup, txt: dup ? 'WhatsApp o placa ya registrados' : 'Sin duplicados' });
  }
  if (d.tipo === 'flota') {
    const selfOk = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'selfie');
    const dpiOk = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'dpi');
    checks.push({ k: 'FOTOS', ok: selfOk && dpiOk, txt: (selfOk && dpiOk) ? 'DPI + selfie recibidos' : 'Faltan foto de DPI y selfie' });
  }
  if (d.tipo === 'usuario') {
    const selfOk = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'selfie');
    checks.push({ k: 'SELFIE', ok: selfOk, txt: selfOk ? 'Selfie de verificación recibida' : 'Sin selfie' });
  }
  // AUTO-APROBACION estilo apps grandes: si TODO pasa la verificacion automatica, entra ya.
  // Solo cae al admin lo raro: licencia en tramite (pide su OK) o checks fallidos.
  const tieneLic = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'licencia');
  const pideOkManual = d.tipo === 'piloto' && d.vehiculo !== 'bicicleta' && d.licenciaEnTramite === true && !tieneLic;
  const todoOk = checks.every(c => c.ok) && !pideOkManual;
  let estadoReg = d.tipo === 'usuario' ? 'aprobado' : (todoOk ? 'aprobado' : 'pendiente_verificacion');
  if (dpiRechazado) estadoReg = 'rechazado_falta_dpi';
  const firmaContrato = (d.tipo === 'piloto' || d.tipo === 'local') && d.contrato
    ? { version: 'C-2026.6', aceptado: true, tsFirma: now, ip: (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || null }
    : null;
  data.push({ tipo: d.tipo, datos: d, estado: estadoReg, auto: (d.tipo !== 'usuario' && todoOk) || undefined, checks, ts: now, firmaContrato });
  await ghPut(f ? f.sha : null, data);
  const icono = { piloto: '🏍️', local: '🏪', flota: '🚚', usuario: '👤' }[d.tipo] || '📋';
  await avisoFotos((d.tipo === 'piloto' || d.tipo === 'flota') ? (d.docs || []) : [], (d.nombre || '') + ' (' + (d.tipo || '') + ')');
  await aviso(`🚀 DRAGOEXPRES — Registro nuevo\n${icono} ${d.tipo.toUpperCase()}: ${d.nombre}\nWhatsApp: ${d.tel}\nZona: ${d.zona}${d.vehiculo ? '\nVehículo: ' + d.vehiculo + (d.placa ? ' (' + d.placa + ')' : '') : ''}${d.propio ? '\n🛺 DUEÑO-CONDUCTOR: el vehículo es suyo y lo maneja él mismo (gana el 100%, sin split 75/25)' : ''}${(d.licenciaEnTramite && d.vehiculo !== 'bicicleta') ? '\n📜 LICENCIA EN TRÁMITE: pide tu OK especial para trabajar mientras la tramita (abrí el detalle 📄 antes de aprobar)' : ''}${d.rubro ? '\nRubro: ' + d.rubro : ''}${d.servicios && d.servicios.length ? '\nTrabaja en: ' + d.servicios.join(', ') : ''}${(d.tipo === 'piloto' || d.tipo === 'flota') ? '\nVerificación: ' + checks.map(c => (c.ok ? '✅' : '❌') + c.k).join(' ') + '\n📸 Las fotos reales llegan en el mensaje de arriba: MIRALAS. Si una foto no es lo que debe ser (un pie, un peluche, cualquier cosa), desactivalo con ✕ al toque.' : ''}${firmaContrato ? '\n✍️ Contrato ' + firmaContrato.version + ' aceptado digitalmente' : ''}${d.referido ? '\n🤝 Referido por: ' + d.referido : ''}${d.tipo === 'usuario' ? '\n✅ Auto-verificado (selfie + WhatsApp) — ya puede pedir' : ''}\n→ ${d.tipo === 'usuario' ? 'Visible en pestaña Usuarios' : (estadoReg === 'aprobado' ? (pideOkManual ? '' : '✅ AUTO-APROBADO (todo pasó la verificación): ya puede entrar a trabajar. Sus datos quedaron en tu panel; si algo te suena raro, desactivalo con ✕') : (estadoReg === 'rechazado_falta_dpi' ? '🚫 RECHAZADO: faltan las fotos del DPI (frente y reverso). NO puede ingresar a la app hasta re-registrarse con ambas fotos. Cero pilotos fantasmas.' : '⏳ PENDIENTE: revisalo en el panel admin'))}`);
  // AVISOS PUSH a los usuarios de la zona (como las apps grandes):
  // cuando se auto-aprueba un LOCAL -> "ya está en DragoExpres"
  // cuando se auto-aprueba un PILOTO -> "pedí tu primer viaje, ya te espera tu piloto"
  try {
    if (estadoReg === 'aprobado' && (d.tipo === 'local' || d.tipo === 'piloto') && d.zona) {
      const f = await ghGetPath('pushsubs.json');
      const all = (f ? f.data : []).filter(s => s && s.endpoint && s.keys && (s.zona || '').trim() === String(d.zona).trim());
      if (all.length) {
        const obj = d.tipo === 'local'
          ? { title: '🏪 ¡' + String(d.nombre).slice(0, 40) + ' ya está en DragoExpres!', body: 'Ahora podés pedir desde la app en ' + d.zona + '. Tocá para verlo.', tag: 'dx-local', url: 'https://dragoexpres.vercel.app/pedir.html' }
          : { title: '🏍️ ¡Ya hay piloto en ' + d.zona + '!', body: 'Pedí tu primer envío o viaje — tu piloto DragoExpres ya te espera. Tocá para pedir.', tag: 'dx-piloto', url: 'https://dragoexpres.vercel.app/pedir.html' };
        const rr2 = await pushA(all, obj);
        if (rr2.vivas.length !== all.length) {
          try {
            const muertas = new Set(all.filter(s => !rr2.vivas.some(v => v.endpoint === s.endpoint)).map(s => s.endpoint));
            const ff2 = await ghGetPath('pushsubs.json');
            if (ff2) {
              const quedan = ff2.data.filter(s => !muertas.has(s.endpoint));
              if (usaDb) { await dbPut('pushsubs.json', null, quedan, 'push: limpia suscripciones muertas'); } else { await fetch(`https://api.github.com/repos/${REPO}/contents/pushsubs.json`, { method: 'PUT', headers: { ...H(), 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'push: limpia suscripciones muertas', content: Buffer.from(JSON.stringify(quedan)).toString('base64'), sha: ff2.sha, branch: BRANCH }) }); }
            }
          } catch (e2) { }
        }
      }
    }
  } catch (e) { }
  return res.status(200).json({ ok: true, mensaje: 'Registro recibido', estado: estadoReg });
});
