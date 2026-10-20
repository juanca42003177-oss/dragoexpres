// Ayudantes compartidos de DragoExpres (los archivos _* no se despliegan como funciones).
const REPO = process.env.GITHUB_DATA_REPO || 'juanca42003177-oss/dragon-labs-data';
const BRANCH = 'dragoexpres-data';
const TOKEN = () => process.env.GITHUB_TOKEN || '';
const H = () => ({ Authorization: 'Bearer ' + TOKEN(), Accept: 'application/vnd.github+json' });

let branchReady = false;
async function ensureBranch() {
  if (branchReady) return;
  const chk = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${BRANCH}`, { headers: H() });
  if (chk.ok) { branchReady = true; return; }
  const chkMe = await fetch('https://api.github.com/user', { headers: H() });
  if (!chkMe.ok) throw new Error('GITHUB_TOKEN invalido o ausente (HTTP ' + chkMe.status + ')');
  // la rama por defecto de la bodega puede llamarse distinto de 'main'
  const rb = await fetch(`https://api.github.com/repos/${REPO}`, { headers: H() });
  if (!rb.ok) throw new Error('repo de datos no accesible (HTTP ' + rb.status + ', usando: ' + REPO + ')');
  const rj = await rb.json();
  const base = rj.default_branch || 'main';
  const mb = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${base}`, { headers: H() });
  if (!mb.ok) throw new Error('rama base ' + base + ' no encontrada (HTTP ' + mb.status + ')');
  const mj = await mb.json();
  const cr = await fetch(`https://api.github.com/repos/${REPO}/git/refs`, {
    method: 'POST',
    headers: { ...H(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: mj.object.sha }),
  });
  if (cr.ok || cr.status === 422) { branchReady = true; return; }
  throw new Error('crear rama HTTP ' + cr.status);
}

// Acepta el formato del cliente ({tipo, datos:{nombre,tel,zona}}) y el plano
// ({tipo,nombre,whatsapp,zona}) indistintamente.
function normalizar(body) {
  const src = (body && body.datos && !body.nombre) ? body.datos : (body || {});
  return {
    tipo: (body && body.tipo) || src.tipo || '',
    nombre: String(src.nombre || '').slice(0, 80),
    tel: String(src.whatsapp || src.tel || '').slice(0, 25),
    zona: String(src.zona || '').slice(0, 80),
    vehiculo: src.vehiculo || undefined,
    rubro: src.rubro || (body && body.tipo === 'local' ? src.tipo : undefined),
    marca: src.marca || undefined,
    color: src.color || undefined,
    placa: src.placa || undefined,
    equipo: src.equipo || undefined,
    h24: src.h24 || undefined,
    dpi: String(src.dpi || '').replace(/\D/g, '').slice(0, 13) || undefined,
    contrato: src.contrato === true || src.contrato === 'true',
    docs: Array.isArray(src.docs) ? src.docs.slice(0, 4).map(y => ({ tipo: String(y.tipo || '').replace(/[^a-z]/g, '').slice(0, 10), archivo: String(y.archivo || '').replace(/[^a-z0-9_\/.-]/gi, '').slice(0, 120) })) : undefined,
  };
}
module.exports = { REPO, BRANCH, TOKEN, H, ensureBranch, normalizar };
