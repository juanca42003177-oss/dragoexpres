// Panel de administracion DragoExpres (solo Juan). Requiere ADMIN_PASS en Vercel.
const wrap = require('./_cors');
const { ensureBranch } = require('./_dx');
const REPO = process.env.GITHUB_DATA_REPO || 'juanca42003177-oss/dragon-labs-data';
const BRANCH = 'dragoexpres-data';
const TOKEN = () => process.env.GITHUB_TOKEN || '';
const PATH = 'registros.json';
const okPass = (p) => process.env.ADMIN_PASS && String(p).trim() === String(process.env.ADMIN_PASS).trim();

async function ghGet(p = PATH) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${p}?ref=${BRANCH}`, {
    headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}
async function ghPut(p, sha, data, msg) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${p}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg || 'admin: actualizar', branch: BRANCH, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'), sha: sha || undefined }),
  });
  if (!r.ok) throw new Error('guardar HTTP ' + r.status);
}
module.exports = wrap(async (req, res) => {
  const d = req.body || {};
  const action = d.action || (req.query && req.query.action) || '';
  if (!okPass(d.pass)) return res.status(200).json({ ok: false, error: 'Acceso denegado' });
  if (action === 'check') return res.status(200).json({ ok: true });
  await ensureBranch();
  const f = await ghGet();
  const data = f ? f.data : [];
  if (action === 'list') {
    try { await ensureBranch(); } catch (e) {}

    return res.status(200).json({ ok: true, registros: data });
  }
  if (action === 'aprobar' || action === 'rechazar') {
    // blindaje: reintenta con lectura fresca si la bodega se estaba actualizando a la vez (HTTP 409)
    for (let intento = 0; intento < 3; intento++) {
      const f2 = intento === 0 && f ? f : await ghGet();
      const data2 = f2 ? f2.data : [];
      const i = data2.findIndex(r => String(r.ts) === String(d.ts));
      if (i < 0) return res.status(200).json({ ok: false, error: 'Registro no encontrado' });
      data2[i].estado = action === 'aprobar' ? 'aprobado' : 'rechazado';
      try {
        await ghPut(PATH, f2 ? f2.sha : null, data2, 'admin: actualizar registro');
        return res.status(200).json({ ok: true, estado: data2[i].estado });
      } catch (e) {
        if (intento === 2) return res.status(200).json({ ok: false, error: 'El sistema se estaba actualizando justo ahora. Tocá de nuevo en 5 segundos.' });
        await new Promise(r2 => setTimeout(r2, 1500));
      }
    }
  }
  if (action === 'pedidos') {
    // pedidos.json vive en la misma rama; se lee aparte para no romper si aún no existe
    const rp = await fetch(`https://api.github.com/repos/${REPO}/contents/pedidos.json?ref=${BRANCH}`, { headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' } });
    const pedidos = rp.ok ? JSON.parse(Buffer.from((await rp.json()).content, 'base64').toString('utf8') || '[]') : [];
    const comisiones = pedidos.reduce((s, o) => s + (o.estado === 'entregado' ? (o.comision || 0) + (o.comisionLocal || 0) : 0), 0);
    const porEstado = {};
    pedidos.forEach(o => porEstado[o.estado] = (porEstado[o.estado] || 0) + 1);
    return res.status(200).json({ ok: true, pedidos: pedidos.slice(-60).reverse(), total: pedidos.length, comisiones, porEstado });
  }
  if (action === 'liquidaciones') {
    const fp = await ghGet('pilots.json');
    const arr = fp ? fp.data : [];
    return res.status(200).json({ ok: true, pendientes: arr.filter(x => x.pendiente).map(x => ({ tel: x.tel, nombre: x.nombre || x.tel, monto: x.pendiente.monto, desde: x.pendiente.desde, retraso: !!x.retraso, rachaRespaldo: !!x.rachaRespaldo })), rachasPerdidas: arr.filter(x => x.rachaRespaldo).map(x => ({ tel: x.tel, nombre: x.nombre || x.tel, racha: x.rachaRespaldo.racha, boletos: x.rachaRespaldo.boletos })) });
  }
  if (action === 'vivo') {
    const fp = await ghGet('pilots.json'); const arr = fp ? fp.data : [];
    const fpd = await ghGet('pedidos.json'); const peds = fpd ? fpd.data : [];
    const fpr = await ghGet('registros.json'); const regs = fpr ? fpr.data : [];
    const activos = ['buscando', 'asignado', 'aceptado', 'en_camino'];
    const porEstado = {}; activos.forEach(e2 => porEstado[e2] = 0);
    peds.forEach(o => { if (activos.includes(o.estado)) porEstado[o.estado]++; });
    return res.status(200).json({ ok: true, vivo: {
      pilotosDisponibles: arr.filter(x => x.disponible && !(x.pendiente && !x.pendiente.pagado)).length,
      pilotosOcupados: new Set(peds.filter(o => o.piloto && ['asignado','aceptado','en_camino'].includes(o.estado)).map(o => o.piloto.tel)).size,
      pendientesPago: arr.filter(x => x.pendiente && !x.pendiente.pagado).length,
      pedidos: porEstado,
      entregadosHoy: peds.filter(o => o.estado === 'entregado' && new Date((o.tsEntregado||0) - 21600000).toISOString().slice(0,10) === new Date(Date.now() - 21600000).toISOString().slice(0,10)).length,
      localesAprobados: regs.filter(r => r.tipo === 'local' && r.estado === 'aprobado').length,
      pilotosAprobados: regs.filter(r => r.tipo === 'piloto' && r.estado === 'aprobado').length,
      pilotosList: regs.filter(r => r.tipo === 'piloto' && r.estado === 'aprobado').map(r => {
        const tel = String((r.datos || {}).tel || '').replace(/\D/g, '');
        const st = arr.find(x => x.tel === tel) || {};
        const mios = peds.filter(o => o.piloto && o.piloto.tel === tel);
        const califs = mios.filter(o => o.califCliente > 0);
        const calif = califs.length ? Math.round(califs.reduce((x, o) => x + o.califCliente, 0) / califs.length * 10) / 10 : null;
        return { nombre: r.datos.nombre, tel, zona: r.datos.zona || '', disponible: !!st.disponible,
          enRuta: mios.some(o => ['asignado', 'aceptado', 'en_camino'].includes(o.estado)),
          calif, malas: califs.filter(o => o.califCliente <= 2).length,
          entregasHoy: mios.filter(o => o.estado === 'entregado' && new Date((o.tsEntregado || 0) - 21600000).toISOString().slice(0, 10) === new Date(Date.now() - 21600000).toISOString().slice(0, 10)).length,
          racha: st.racha || 0, deuda: (st.pendiente && !st.pendiente.pagado) ? st.pendiente.monto : 0 };
      }),
      localesList: regs.filter(r => r.tipo === 'local' && r.estado === 'aprobado').map(r => {
        const tel = String((r.datos || {}).tel || '').replace(/\D/g, '');
        const mios = peds.filter(o => o.local && o.local.tel === tel);
        const entSem = mios.filter(o => o.estado === 'entregado' && (o.tsEntregado || 0) >= Date.now() - 7 * 86400000);
        return { nombre: r.datos.nombre, tel, zona: r.datos.zona || '',
          pedidosHoy: mios.filter(o => new Date((o.ts || 0) - 21600000).toISOString().slice(0, 10) === new Date(Date.now() - 21600000).toISOString().slice(0, 10)).length,
          pedidosSemana: entSem.length, ventasSemana: Math.round(entSem.reduce((x, o) => x + (o.compra || 0), 0) * 10) / 10 };
      }),
      resenas: peds.filter(o => (o.califCliente > 0 && o.califCliente <= 2) || (o.califPiloto > 0 && o.califPiloto <= 2)).slice(-12).reverse()
        .map(o => ({ id: o.id, cliente: (o.cliente || {}).nombre || '', piloto: (o.piloto || {}).nombre || '', pilotoTel: String((o.piloto || {}).tel || '').replace(/\D/g, ''), califCliente: o.califCliente || 0, califPiloto: o.califPiloto || 0, texto: String(o.califClienteTxt || o.califPilotoTxt || '').slice(0, 160), detalle: String(o.detalle || '').slice(0, 60) }))
    } });
  }
  if (action === 'rachaOk') {
    const tel = String(d.tel || '').trim();
    const fp = await ghGet('pilots.json');
    const arr = fp ? fp.data : [];
    const st = arr.find(x => x.tel === tel);
    if (!st || !st.rachaRespaldo) return res.status(200).json({ ok: false, error: 'No hay racha perdida que restaurar (o ya fue restaurada).' });
    st.racha = st.rachaRespaldo.racha; st.boletosExtra = st.rachaRespaldo.boletos;
    delete st.rachaRespaldo;
    await ghPut('pilots.json', fp ? fp.sha : null, arr, 'racha restaurada ' + tel);
    return res.status(200).json({ ok: true, racha: st.racha, boletos: st.boletosExtra });
  }
  if (action === 'liqOk') {
    const tel = String(d.tel || '').trim();
    const fp = await ghGet('pilots.json');
    const arr = fp ? fp.data : [];
    const st = arr.find(x => x.tel === tel);
    if (!st) return res.status(200).json({ ok: false, error: 'Piloto no encontrado.' });
    let perdioRacha = false;
    if (st.retraso) { st.rachaRespaldo = { racha: st.racha || 0, boletos: st.boletosExtra || 0 }; st.racha = 0; st.boletosExtra = 0; delete st.retraso; perdioRacha = true; }
    delete st.pendiente;
    delete st.susp;
    await ghPut('pilots.json', fp ? fp.sha : null, arr, 'liquidado ' + tel);
    return res.status(200).json({ ok: true, perdioRacha, rachaRespaldo: st.rachaRespaldo || null });
  }
  if (action === 'detalle') {
    const tel = String(d.tel || '').replace(/\D/g, '');
    const tel8 = tel.slice(-8);
    const reg = f.data.find(r => { const t = String((r.datos || {}).tel || '').replace(/\D/g, ''); return t === tel || (tel8.length === 8 && t.slice(-8) === tel8); }) || null;
    if (!reg) return res.status(200).json({ ok: false, error: 'No encontrado.' });
    const telReal = String((reg.datos || {}).tel || '').replace(/\D/g, '') || tel; // tel canonico del registro (para pedidos/pilots)
    const H2 = () => ({ Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' });
    const r2 = await fetch(`https://api.github.com/repos/${REPO}/contents/pedidos.json?ref=${BRANCH}`, { headers: H2() });
    const peds = r2.ok ? JSON.parse(Buffer.from((await r2.json()).content, 'base64').toString('utf8') || '[]') : [];
    const mios = peds.filter(x => x.piloto && String(x.piloto.tel).replace(/\D/g, '') === telReal && x.estado === 'entregado');
    const r3 = await fetch(`https://api.github.com/repos/${REPO}/contents/pilots.json?ref=${BRANCH}`, { headers: H2() });
    const pilots = r3.ok ? JSON.parse(Buffer.from((await r3.json()).content, 'base64').toString('utf8') || '[]') : [];
    const st = pilots.find(x => String(x.tel).replace(/\D/g, '') === telReal) || {};
    const califs = mios.filter(x => x.califCliente > 0);
    const g = new Date(Date.now() - 21600000);
    const lunes = new Date(g);
    lunes.setUTCDate(g.getUTCDate() - ((g.getUTCDay() + 6) % 7));
    lunes.setUTCHours(0, 0, 0, 0);
    const semana = mios.filter(x => (x.tsEntregado || x.ts) >= lunes.getTime() + 21600000).length;
    const dinero2 = (q) => Math.round(+q * 100) / 100;
    const firma = reg.firmaContrato || null;
    const firmaTxt = firma ? ('✍️ Contrato ' + firma.version + ' aceptado digitalmente el ' + new Date((firma.tsFirma || reg.ts) - 21600000).toISOString().replace('T', ' ').slice(0, 16) + ' GT' + (firma.ip ? ' · IP ' + String(firma.ip).split(',')[0].trim() : '')) : 'Sin contrato firmado (registro anterior)';
    return res.status(200).json({ ok: true, registro: reg.datos, estado: reg.estado, auto: !!reg.auto, checks: reg.checks || [], docs: (reg.datos && reg.datos.docs) || [], firmaContrato: firmaTxt, stats: {
      entregas: mios.length,
      semana,
      ganado: dinero2(mios.reduce((s, x) => s + (x.envio - x.comision), 0)),
      comisiones: dinero2(mios.reduce((s, x) => s + (x.comision || 0) + (x.comisionLocal || 0), 0)),
      calif: califs.length ? Math.round(califs.reduce((s, x) => s + x.califCliente, 0) / califs.length * 10) / 10 : null,
      pendiente: st.pendiente ? st.pendiente.monto : 0
    }});
  }
  if (action === 'doc') {
    const archivo = String(d.archivo || '').replace(/[^a-z0-9_/.,-]/gi, '');
    if (!archivo) return res.status(200).json({ ok: false, error: 'Documento inválido.' });
    const archivoEnc = archivo.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/dragoexpres/${archivoEnc}?ref=${BRANCH}`, {
      headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' }
    });
    if (!r.ok) return res.status(200).json({ ok: false, error: 'Documento no encontrado (HTTP ' + r.status + ')' });
    const j = await r.json();
    return res.status(200).json({ ok: true, img: 'data:image/jpeg;base64,' + j.content });
  }
  if (action === 'sugerencias') {
    const fs = await ghGet('sugerencias.json');
    const arr = fs ? fs.data : [];
    return res.status(200).json({ ok: true, sugerencias: arr.slice(-30).reverse() });
  }
  if (action === 'sugLeida') {
    const fs = await ghGet('sugerencias.json');
    const arr = fs ? fs.data : [];
    const x = arr.find(y => y.id === String(b.id || ''));
    if (x) { x.leida = true; await ghPut('sugerencias.json', fs ? fs.sha : null, arr, 'sugerencia leida ' + b.id); }
    return res.status(200).json({ ok: true });
  }
  if (action === 'sugDel') {
    const fs = await ghGet('sugerencias.json');
    const arr = fs ? fs.data : [];
    const nueva = arr.filter(y => y.id !== String(b.id || ''));
    await ghPut('sugerencias.json', fs ? fs.sha : null, nueva, 'sugerencia borrada ' + b.id);
    return res.status(200).json({ ok: true });
  }
  if (action === 'pozo') {
    const rp = await fetch(`https://api.github.com/repos/${REPO}/contents/pedidos.json?ref=${BRANCH}`, { headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' } });
    const pedidos = rp.ok ? JSON.parse(Buffer.from((await rp.json()).content, 'base64').toString('utf8') || '[]') : [];
    const TZ = 6 * 3600 * 1000;
    const g = new Date(Date.now() - TZ);
    const lunes = Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate() - (g.getUTCDay() + 6) % 7) + TZ;
    const entregados = pedidos.filter(o => o.estado === 'entregado' && (o.tsEntregado || o.ts) >= lunes);
    const comisiones = entregados.reduce((s, o) => s + (o.comision || 0) + (o.comisionLocal || 0), 0);
    const por = {};
    entregados.forEach(o => { if (o.piloto) { const k = o.piloto.tel; if (!por[k]) por[k] = { nombre: o.piloto.nombre, tel: k, entregas: 0, comisiones: 0 }; por[k].entregas++; por[k].comisiones += (o.comision || 0) + (o.comisionLocal || 0); } });
    let metaGlobal = 20;
    try { const rpz = await fetch(`https://api.github.com/repos/${REPO}/contents/pozo.json?ref=${BRANCH}`, { headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' } }); if (rpz.ok) metaGlobal = (JSON.parse(Buffer.from((await rpz.json()).content, 'base64').toString('utf8')) || {}).metaGlobal || 20; } catch (e) { }
    try { const rpl = await fetch(`https://api.github.com/repos/${REPO}/contents/pilots.json?ref=${BRANCH}`, { headers: { Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' } }); if (rpl.ok) { const sts = JSON.parse(Buffer.from((await rpl.json()).content, 'base64').toString('utf8')) || []; Object.values(por).forEach(p => { const st = sts.find(x => String(x.tel).replace(/\D/g, '') === String(p.tel).replace(/\D/g, '')); p.metaP = (st && st.metaP) || 20; }); } } catch (e) { }
    const pilotos = Object.values(por).map(x => { x.metaEfectiva = Math.min(x.metaP || 20, metaGlobal); return { nombre: x.nombre, entregas: x.entregas, premio: Math.round(x.comisiones * 25) / 100, meta: x.metaEfectiva, metaP: x.metaP || 20 }; }).sort((x, y) => y.entregas - x.entregas);
    return res.status(200).json({ ok: true, meta: metaGlobal, comisiones, pozo: Math.round(pilotos.filter(p => p.entregas >= p.meta).reduce((s, p) => s + p.premio, 0) * 100) / 100, modo: 'individual', pilotos });
  }
  return res.status(200).json({ ok: false, error: 'Acción desconocida' });
});
