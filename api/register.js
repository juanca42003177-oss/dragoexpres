// Registro de pilotos, locales, flotistas y usuarios de DragoExpres.
// Los registros (datos personales) se guardan en el repo PRIVADO de datos,
// rama 'dragoexpres-data', archivo registros.json — nunca en repos publicos.
const wrap = require('./_cors');
const { REPO, BRANCH, TOKEN, H, ensureBranch, normalizar } = require('./_dx');
const PATH = 'registros.json';

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
  await ensureBranch();
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${BRANCH}`, { headers: H() });
  if (!r.ok) return null;
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}
async function ghPut(sha, data) {
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
  if (!d.tipo || !d.nombre || !d.tel || !d.zona) {
    return res.status(200).json({ ok: false, error: 'Faltan datos: nombre, WhatsApp y área son obligatorios.' });
  }
  const f = await ghGet();
  const data = f ? f.data : [];
  // VERIFICACION AUTOMATICA de asociados (motos, carros, bicicletas) y usuarios
  const checks = [];
  const limpiar = (q) => String(q || '').replace(/\D/g, '');
  if ((d.tipo === 'piloto' || d.tipo === 'local') && d.contrato !== true) return res.status(200).json({ ok: false, error: 'Para registrarte tenés que aceptar el Contrato Digital de DragoExpres.' });
  if (d.tipo === 'piloto') {
    const dpiOk = limpiar(d.dpi).length === 13;
    checks.push({ k: 'DPI', ok: dpiOk, txt: dpiOk ? 'DPI de 13 dígitos' : 'DPI incompleto (' + limpiar(d.dpi).length + '/13)' });
    const nDocs = Array.isArray(d.docs) ? d.docs.length : 0;
    const esBici = d.vehiculo === 'bicicleta';
    const enTramite = d.licenciaEnTramite === true;
    const tieneLic = Array.isArray(d.docs) && d.docs.some(y => y.tipo === 'licencia');
    const docsOk = esBici ? nDocs >= 2 : (tieneLic ? nDocs >= 3 : (enTramite && nDocs >= 2));
    checks.push({ k: 'FOTOS', ok: docsOk, txt: nDocs + '/' + ((esBici || (enTramite && !tieneLic)) ? 2 : 3) + ' fotos' + (esBici ? ' (bicicleta: DPI + selfie)' : (enTramite && !tieneLic ? ' (DPI + selfie, licencia en trámite 📜)' : ' (DPI + licencia + selfie)')) });
    checks.push({ k: 'LICENCIA', ok: esBici ? true : (tieneLic || enTramite), txt: esBici ? 'Bicicleta: no requiere licencia' : (tieneLic ? 'Foto de licencia recibida' : (enTramite ? '📜 EN TRÁMITE — pide tu OK para trabajar mientras la tramita' : 'Falta la foto de la licencia')) });
    const placaOk = d.vehiculo === 'bicicleta' || /^[A-Z0-9-]{5,10}$/i.test(String(d.placa || ''));
    checks.push({ k: 'PLACA', ok: placaOk, txt: placaOk ? (d.vehiculo === 'bicicleta' ? 'Bicicleta (sin placa)' : 'Placa válida: ' + d.placa) : 'Placa inválida' });
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
  const estadoReg = d.tipo === 'usuario' ? 'aprobado' : 'pendiente_verificacion';
  const firmaContrato = (d.tipo === 'piloto' || d.tipo === 'local') && d.contrato
    ? { version: 'C-2026.5', aceptado: true, tsFirma: now, ip: (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || null }
    : null;
  data.push({ tipo: d.tipo, datos: d, estado: estadoReg, checks, ts: now, firmaContrato });
  await ghPut(f ? f.sha : null, data);
  const icono = { piloto: '🏍️', local: '🏪', flota: '🚚', usuario: '👤' }[d.tipo] || '📋';
  await aviso(`🚀 DRAGOEXPRES — Registro nuevo\n${icono} ${d.tipo.toUpperCase()}: ${d.nombre}\nWhatsApp: ${d.tel}\nZona: ${d.zona}${d.vehiculo ? '\nVehículo: ' + d.vehiculo + (d.placa ? ' (' + d.placa + ')' : '') : ''}${d.propio ? '\n🛺 DUEÑO-CONDUCTOR: el vehículo es suyo y lo maneja él mismo (gana el 100%, sin split 75/25)' : ''}${(d.licenciaEnTramite && d.vehiculo !== 'bicicleta') ? '\n📜 LICENCIA EN TRÁMITE: pide tu OK especial para trabajar mientras la tramita (abrí el detalle 📄 antes de aprobar)' : ''}${d.rubro ? '\nRubro: ' + d.rubro : ''}${(d.tipo === 'piloto' || d.tipo === 'flota') ? '\nVerificación: ' + checks.map(c => (c.ok ? '✅' : '❌') + c.k).join(' ') : ''}${firmaContrato ? '\n✍️ Contrato ' + firmaContrato.version + ' aceptado digitalmente' : ''}${d.tipo === 'usuario' ? '\n✅ Auto-verificado (selfie + WhatsApp) — ya puede pedir' : ''}\n→ ${d.tipo === 'usuario' ? 'Visible en pestaña Usuarios' : 'Revisalo en el panel admin (pendiente de aprobar)'}`);
  return res.status(200).json({ ok: true, mensaje: 'Registro recibido' });
});
