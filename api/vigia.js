// DragoExpres — VIGÍA (soporte técnico de Juan, gratis).
// Un cron externo gratuito (cron-job.org o UptimeRobot) llama este endpoint
// cada 5 minutos. Verifica que la bodega (GitHub) responda y que la
// liquidación de 72h no esté atascada. Avisa por Telegram SOLO cuando el
// estado cambia (ok→falla y falla→ok, máximo 1 recordatorio cada 6h si
// sigue fallando) para no gastar ni spamear.
const wrap = require('./_cors');
const { REPO, BRANCH, H, ensureBranch } = require('./_dx');

const CICLO_MS = 72 * 3600 * 1000;
const TOLERANCIA_CICLO = 80 * 3600 * 1000; // ciclo + margen antes de gritar
const RERECORDAR = 6 * 3600 * 1000; // si sigue fallando, recorda cada 6h

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

async function despertarAgente(payload) {
  try {
    const url = process.env.DX_ALERT_WEBHOOK;
    if (!url) return false; // Juan aún no configuró la URL en Vercel: solo avisa Telegram
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return r.ok;
  } catch (e) { return false; }
}
async function aviso(texto) {
  try {
    const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID || '8022768138';
    if (!tok) return;
    await fetch('https://api.telegram.org/bot' + tok + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: texto }) });
  } catch (e) { }
}

module.exports = wrap(async (req, res) => {
  const now = Date.now();
  // PRUEBA de la cadena completa (Juan la abre en su navegador): despierta al agente sin marcar falla
  if ((req.query || {}).test === '1') {
    const problemas = ['PRUEBA de la cadena de alertas: verificá que DragoExpres responda y avisale a Juan que todo funciona.'];
    const enviado = await despertarAgente({ app: 'dragoexpres', tipo: 'test', problemas, detalle: 'PRUEBA de Juan: cadena de soporte. Si leés esto, confirmá que la app responde bien y avisale.', ts: Date.now() });
    await aviso('🧪 DragoExpres: PRUEBA de la cadena de soporte disparada' + (enviado ? ' — agente despertado.' : ' — agente NO despertado: falta la variable DX_ALERT_WEBHOOK en Vercel.'));
    let host = '';
    try { host = new URL(process.env.DX_ALERT_WEBHOOK || '').hostname; } catch (e) { host = 'URL_INVALIDA'; }
    return res.status(200).json({ ok: true, prueba: 'disparada', agenteDespertado: enviado, urlApuntaA: host });
  }

  const problemas = [];

  // 1) bodega viva: los archivos que usa el día a día
  const checks = [['pedidos.json'], ['pilots.json'], ['locales.json'], ['menus.json']];
  for (const [f] of checks) {
    try {
      const x = await ghGet(f);
      if (!x) problemas.push('bodega no responde: ' + f);
    } catch (e) { problemas.push('bodega falló: ' + f); }
  }

  // 2) liquidación de 72h viva (si el cron de ciclo se atascó, avisa)
  let cicloVivo = true;
  let fp = null;
  for (let int = 0; int < 2 && !(fp && fp.data); int++) { try { fp = await ghGet('pozo.json'); } catch (e) { fp = null; } if (!(fp && fp.data)) await new Promise(r => setTimeout(r, 3000)); }
  try {
    const ultimo = fp && fp.data ? (fp.data.tsUltimoCiclo || 0) : 0;
    if (!fp || !fp.data) { problemas.push('ciclo: la lectura de pozo.json falló (puede ser transitorio de GitHub, ya se reintentó 2 veces)'); }
    else if (!ultimo || now - ultimo > TOLERANCIA_CICLO) { cicloVivo = false; problemas.push('liquidación 72h atascada: última ' + (ultimo ? new Date(ultimo - 6 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' GT' : 'nunca')); }
  } catch (e) { problemas.push('ciclo: error leyendo el estado'); }

  const ok = problemas.length === 0;

  // 3) estado con memoria para avisar SOLO en el cambio (y cada 6h si persiste)
  let st = { estado: 'ok', ultimoAviso: 0, desde: now };
  try {
    const fs2 = await ghGet('salud.json');
    if (fs2 && fs2.data && fs2.data.estado) st = fs2.data;
  } catch (e) { }
  let cambio = false;
  if (ok && st.estado === 'falla') {
    cambio = true;
    await aviso('🟢 DragoExpres: todo volvió a la normalidad. Puedes seguir tranquilo. — Vigía');
    st = { estado: 'ok', ultimoAviso: now, desde: st.desde || now };
  } else if (!ok && (st.estado !== 'falla' || now - (st.ultimoAviso || 0) > RERECORDAR)) {
    cambio = true;
    await aviso('🔴 DragoExpres FALLA — Vigía detectó:\n' + problemas.map(p => '• ' + p).join('\n') + '\n\nRevisa la app. Si no responde, escribile a Solene con este mensaje.');
    await despertarAgente({ app: 'dragoexpres', tipo: 'fallo', problemas, detalle: 'Fallo real detectado por el Vigía: ' + problemas.join(' | '), ts: Date.now() });
    st = { estado: 'falla', ultimoAviso: now, desde: st.estado === 'falla' ? (st.desde || now) : now };
  }
  if (cambio) {
    try {
      const fs2 = await ghGet('salud.json');
      await ghPut('salud.json', fs2 ? fs2.sha : null, st, 'vigia: estado ' + st.estado);
    } catch (e) { }
  }

  res.status(ok ? 200 : 503).json({ ok, cicloVivo, problemas, proximoRecordatorioMin: ok ? 0 : Math.max(0, Math.round((st.ultimoAviso + RERECORDAR - now) / 60000)) });
});
