// DragoExpres — Recompensas semanales de pilotos (modelo INDIVIDUAL, regla de Juan 2026-10-20).
// NOTA: la LIQUIDACIÓN de comisiones corre cada 72h en api/ciclo.js.
// Acá solo: reparto dominical, reset de rachas/boletos, avisos.
//
// MODELO INDIVIDUAL: cada piloto compite contra la meta, no contra otros.
// Meta: 20 entregas (lunes→domingo GT).
// Si cumple: recibe el 25% de SUS PROPIAS comisiones de la semana + su acumulado individual.
// Si no cumple: su 25% de la semana se acumula SOLO PARA ÉL (pozo individual, nunca se junta con el de otros).
// El premio se acredita como bono (st.bonosPend) y descuenta de lo que transfiere en la próxima liquidación:
// Juan comparte las comisiones que ese mismo piloto generó — nunca pone de su bolsillo ni paga con la plata de otros.
const wrap = require('./_cors');
const { REPO, BRANCH, H, ensureBranch } = require('./_dx');

const TZ = 6 * 3600 * 1000;
const dinero = (q) => Math.max(0, Math.round(+q * 100) / 100);
const META = 20, PCT_POZO = 0.25;
// Meta dinamica (regla de Juan 2026-10-20, estilo dificultad de cripto):
// - Base 20. Cumplir 4 domingos SEGUIDOS suma +2 a la meta personal (progresion).
// - Tope global auto-ajustado por demanda: 75% del promedio de entregas por piloto activo.
// - Piso 10 y techo 40 para no humillar ni explotar a nadie. Objetivo: que al menos el 75% llegue.
const META_BASE = 20, SUBIDA_META = 2, SEMANAS_PARA_SUBIR = 4, META_MIN = 10, META_MAX = 40, TARGET = 0.75;

function lunesGT() {
  const g = new Date(Date.now() - TZ);
  const diasDesdeLunes = (g.getUTCDay() + 6) % 7;
  return Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate() - diasDesdeLunes) + TZ;
}
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

async function estado() {
  const L = lunesGT();
  const fpd = await ghGet('pedidos.json');
  const peds = (fpd ? fpd.data : []).filter(o => o.estado === 'entregado' && (o.tsEntregado || o.ts) >= L);
  const pz = await ghGet('pozo.json');
  const pozo = pz && !Array.isArray(pz.data) ? pz.data : {};
  pozo.acumuladoPor = pozo.acumuladoPor || {};
  const metaGlobal = pozo.metaGlobal || META_BASE;
  const porPiloto = {};
  peds.forEach(o => {
    if (!o.piloto) return;
    const k = o.piloto.tel;
    if (!porPiloto[k]) porPiloto[k] = { tel: k, nombre: o.piloto.nombre, entregas: 0, comisiones: 0 };
    porPiloto[k].entregas++;
    porPiloto[k].comisiones = dinero(porPiloto[k].comisiones + (o.comision || 0) + (o.comisionLocal || 0));
  });
  const pilotos = Object.values(porPiloto).sort((a, b) => b.entregas - a.entregas);
  try {
    const fpl = await ghGet('pilots.json');
    (fpl ? fpl.data : []).forEach(st => { const pp = porPiloto[st.tel]; if (pp) { pp.boletos = st.boletosExtra || 0; pp.compensa = st.compensa || 0; pp.metaP = st.metaP || META_BASE; } });
  } catch (e) { }
  // premio INDIVIDUAL: 25% de sus propias comisiones de la semana + SU acumulado individual
  pilotos.forEach(p => { p.metaEfectiva = Math.min(p.metaP || META_BASE, metaGlobal); p.premio = dinero(p.comisiones * PCT_POZO + (pozo.acumuladoPor[p.tel] || 0)); });
  const califican = pilotos.filter(p => p.entregas >= p.metaEfectiva);
  const totalIndividual = dinero(califican.reduce((s, p) => s + p.premio, 0));
  return { meta: metaGlobal, modo: 'individual', pilotos, califican, totalIndividual, faltanDias: 7 - Math.floor((Date.now() - L) / 864e5) };
}

module.exports = wrap(async (req, res) => {
  const q = req.query || {};
  const b = req.body || {};
  const action = b.action || q.action || '';

  if (action === 'estado') {
    const s = await estado();
    return res.status(200).json({ ok: true, ...s });
  }

  if (action === 'ejecutar' || (!action && req.method === 'GET')) {
    // cron de Vercel (GET dominical) o ejecucion manual
    const g = new Date(Date.now() - TZ);
    if (!action && g.getUTCDay() !== 0) return res.status(200).json({ ok: true, skip: 'hoy no es domingo' });
    const s = await estado();
    const pz = await ghGet('pozo.json');
    const pozo = pz && !Array.isArray(pz.data) ? pz.data : {};
    pozo.acumuladoPor = pozo.acumuladoPor || {};
    pozo.historial = pozo.historial || [];

    // 1) los que cumplen: premio acreditado como bono individual (sale de sus propias comisiones)
    const reparto = s.califican.map(p => ({ tel: p.tel, nombre: p.nombre, entregas: p.entregas, monto: p.premio }));
    // 2) los que NO cumplen: su 25% de la semana se acumula SOLO para ellos
    const sinMeta = s.pilotos.filter(p => p.entregas < p.metaEfectiva);
    const acumulan = sinMeta.map(p => {
      const add = dinero(p.comisiones * PCT_POZO);
      pozo.acumuladoPor[p.tel] = dinero((pozo.acumuladoPor[p.tel] || 0) + add);
      return { nombre: p.nombre, tel: p.tel, entregas: p.entregas, acumulado: pozo.acumuladoPor[p.tel] };
    });
    // acreditar premios en pilots.json como bonosPend (descuentan en la próxima liquidación)
    // + PROGRESION DE META: 4 domingos seguidos cumpliendo suman +2 a la meta personal
    const subidasMeta = [];
    if (reparto.length || s.pilotos.length) {
      const fp = await ghGet('pilots.json');
      const arr = fp ? fp.data : [];
      reparto.forEach(r2 => {
        let st = arr.find(x => x.tel === r2.tel);
        if (!st) { st = { tel: r2.tel }; arr.push(st); }
        st.bonosPend = dinero((st.bonosPend || 0) + r2.monto);
        pozo.acumuladoPor[r2.tel] = 0;
      });
      s.pilotos.forEach(p => {
        let st = arr.find(x => x.tel === p.tel);
        if (!st) { st = { tel: p.tel }; arr.push(st); }
        const cumplio = p.entregas >= p.metaEfectiva;
        st.metasSeguidas = cumplio ? (st.metasSeguidas || 0) + 1 : 0;
        st.metaP = st.metaP || META_BASE;
        if (st.metasSeguidas >= SEMANAS_PARA_SUBIR) {
          const antes = st.metaP;
          st.metaP = Math.min(st.metaP + SUBIDA_META, META_MAX);
          st.metasSeguidas = 0;
          if (st.metaP !== antes) subidasMeta.push(`${p.nombre}: meta ${antes} → ${st.metaP} (4 domingos seguidos cumpliendo 🐉)`);
        }
      });
      await ghPut('pilots.json', fp ? fp.sha : null, arr, 'premios + progresion de metas');
    }
    // reset semanal de rachas/boletos
    try {
      const fpr2 = await ghGet('pilots.json');
      const arr2 = fpr2 ? fpr2.data : []; let chg = false;
      arr2.forEach(x => { if (x.racha || x.boletosExtra) { x.racha = 0; x.boletosExtra = 0; chg = true; } });
      if (chg) await ghPut('pilots.json', fpr2.sha, arr2, 'reset semanal de rachas');
    } catch (e) { }

    // RETARGET GLOBAL estilo cripto: la meta sube si hay mucha demanda, baja si hay poca.
    // Objetivo: que al menos el 75% de los pilotos activos llegue a la meta. Piso 10, techo 40.
    const activos = s.pilotos.filter(p => p.entregas > 0);
    let ajuste = null;
    if (activos.length) {
      const totalEntregas = s.pilotos.reduce((s2, p) => s2 + p.entregas, 0);
      const demanda = Math.round((totalEntregas / activos.length) * 10) / 10;
      const anterior = s.meta;
      const nueva = Math.max(META_MIN, Math.min(META_MAX, Math.round(demanda * TARGET)));
      pozo.metaGlobal = nueva;
      ajuste = { anterior, nueva, demanda, activos: activos.length };
    }
    pozo.historial.push({ domingo: g.toISOString().slice(0, 10), reparto, acumulan, modo: 'individual', metaGlobal: pozo.metaGlobal || META_BASE, ajuste });
    await ghPut('pozo.json', pz ? pz.sha : null, pozo, 'recompensas dominicales individuales');

    const GANAN = reparto.length ? reparto.map(p => `• ${p.nombre}: ${p.entregas} entregas → Q${p.monto} de SUS PROPIAS comisiones (se descuenta de su próxima transferencia, vos no ponés nada)`).join('\n') : '— Nadie cumplió la meta de 20 entregas 😢';
    const ACUM = acumulan.length ? '\n\n💰 Pozos individuales acumulados (suyo, nadie más lo toca):\n' + acumulan.map(p => `• ${p.nombre}: acumulado Q${p.acumulado}`).join('\n') : '';
    const rachasPerdidas = [];
    try { const fpx = await ghGet('pilots.json'); (fpx ? fpx.data : []).forEach(x => { if (x.rachaRespaldo) rachasPerdidas.push(x.nombre || x.tel); }); } catch (e) { }

    const AJUSTE = ajuste ? `\n\n📈 META AUTO-AJUSTADA (estilo cripto, objetivo 75%):\nDemanda: ${ajuste.demanda} entregas promedio × ${ajuste.activos} pilotos activos → meta global: ${ajuste.anterior} → ${ajuste.nueva}\nLa meta sube si hay mucho pedidos y baja si hay pocos, para que el 75% llegue.` : '\n\n📈 Sin pilotos activos: la meta global no se mueve.';
    const SUBIDAS = subidasMeta.length ? `\n\n🐉 PROGRESIÓN (4 domingos seguidos cumpliendo = +2):\n${subidasMeta.join('\n')}` : '';
    await aviso(`🏆 DRAGOEXPRES — DEVOLUCIÓN SEMANAL 🐉\nCada piloto que cumple su meta recibe el 25% de SUS comisiones de vuelta. Vos no ponés nada.\n\nGANADORES de hoy:\n${GANAN}${ACUM}${AJUSTE}${SUBIDAS}\n\nLos premios ya quedaron acreditados como bono: se descuentan de lo que cada piloto transfiere en su próxima liquidación de 72h.`);
    return res.status(200).json({ ok: true, reparto, acumulan });
  }

  return res.status(200).json({ ok: false, error: 'Acción desconocida' });
});
