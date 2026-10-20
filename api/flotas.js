// DragoExpres — Flotistas (Fase 3): dueño de vehículo que no maneja.
// El flotista asigna su vehículo a un conductor aprobado y gana 25% del
// neto del conductor; el conductor se queda 75%. flotas.json en la bodega.
const wrap = require('./_cors');
const { REPO, BRANCH, H, ensureBranch } = require('./_dx');

const TZ = 6 * 3600 * 1000;
const semana = () => 'S' + Math.floor((Date.now() - TZ) / (7 * 864e5));
const dinero = (q) => Math.max(0, Math.round(+q * 100) / 100);

async function ghGet(path) {
  await ensureBranch();
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`, { headers: H() });
  if (!r.ok) return null;
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '[]') };
}
async function ghPut(path, sha, data, msg) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...H(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, branch: BRANCH, content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'), sha: sha || undefined }),
  });
  if (!r.ok) throw new Error('guardar ' + path + ' HTTP ' + r.status);
}
async function aviso(texto) {
  try {
    const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID || '8022768138';
    if (!tok) return;
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto }) });
  } catch (e) { }
}

module.exports = wrap(async (req, res) => {
  const b = req.body || {};
  const action = b.action || (req.query && req.query.action) || '';
  const tel = String(b.tel || '').trim();

  if (action === 'login') {
    const placa = String(b.placa || '').trim().toUpperCase();
    const fr = await ghGet('registros.json');
    const reg = fr ? fr.data : [];
    const f = reg.find(r => r.tipo === 'flota' && r.estado === 'aprobado' && String(r.datos.tel).trim() === tel);
    const ff = await ghGet('flotas.json');
    const asigs = (ff ? ff.data : []).filter(x => x.flotista && x.flotista.tel === tel && x.activa !== false);
    const placaValida = f && (!f.datos.placa || String(f.datos.placa).trim().toUpperCase() === placa) || asigs.some(x => x.placa === placa);
    if (!f || !placaValida) return res.status(200).json({ ok: false, error: 'No encontramos tu cuenta de flotista con ese WhatsApp y placa.' });
    const totalSemana = dinero(asigs.reduce((s, x) => s + (x.ganadoSemana || 0), 0));
    return res.status(200).json({ ok: true, flotista: { nombre: f.datos.nombre, tel }, vehiculos: asigs, totalSemana });
  }

  if (action === 'agregar') {
    const placa = String(b.placa || '').trim().toUpperCase();
    const cTel = String(b.conductorTel || '').trim();
    const cNombre = String(b.conductorNombre || '').trim().slice(0, 80);
    const marca = String(b.marca || '').trim().slice(0, 30);
    const color = String(b.color || '').trim().slice(0, 20);
    if (!placa || !cTel || !cNombre) return res.status(200).json({ ok: false, error: 'Faltan placa, nombre y WhatsApp del conductor.' });
    const fr = await ghGet('registros.json');
    const reg = fr ? fr.data : [];
    const f = reg.find(r => r.tipo === 'flota' && r.estado === 'aprobado' && String(r.datos.tel).trim() === tel);
    if (!f) return res.status(200).json({ ok: false, error: 'Solo flotistas aprobados pueden asignar vehículos.' });
    const cond = reg.find(r => r.tipo === 'piloto' && r.estado === 'aprobado' && String(r.datos.tel).trim() === cTel);
    if (!cond) return res.status(200).json({ ok: false, error: 'Ese conductor no es piloto aprobado todavía. Decile que se registre y espere aprobación.' });
    const ff = await ghGet('flotas.json');
    const arr = ff ? ff.data : [];
    let a = arr.find(x => x.placa === placa);
    if (!a) { a = { placa, semana: semana(), ganadoSemana: 0, pedidosSemana: 0 }; arr.push(a); }
    if (marca) a.marca = marca;
    if (color) a.color = color;
    a.flotista = { tel, nombre: f.datos.nombre };
    a.conductor = { tel: cTel, nombre: cNombre };
    a.activa = true;
    await ghPut('flotas.json', ff ? ff.sha : null, arr, 'flota: asignacion ' + placa);
    await aviso(`🚚 DRAGOEXPRES — Flota\n${f.datos.nombre} asignó el vehículo ${placa}${marca ? ' (' + marca + (color ? ' ' + color : '') + ')' : ''} al conductor ${cNombre} (${cTel})\nReparto automático: 75% conductor / 25% flotista en cada entrega`);
    return res.status(200).json({ ok: true, vehiculo: a });
  }

  if (action === 'quitar') {
    const placa = String(b.placa || '').trim().toUpperCase();
    const ff = await ghGet('flotas.json');
    const arr = ff ? ff.data : [];
    const a = arr.find(x => x.placa === placa && x.flotista && x.flotista.tel === tel);
    if (!a) return res.status(200).json({ ok: false, error: 'Vehículo no encontrado.' });
    a.activa = false;
    await ghPut('flotas.json', ff.sha, arr, 'flota: vehiculo desactivado ' + placa);
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: false, error: 'Acción desconocida' });
});
