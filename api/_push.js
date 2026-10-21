/* DragoExpres — Web Push (VAPID) puro Node, sin dependencias: encripta aes128gcm
   (RFC 8291) y firma el JWT ES256 (RFC 8291/8292) con el crypto nativo.
   Claves del proyecto (repo privado). PUB es publica por diseno (el navegador la pide). */
const crypto = require('crypto');
const VAPID_PUB = 'BIcaKWGp2wy-DfqCHtjKlf3jaPMPfqevaxxKxDqEk9mVWq6w6aNPGG-IJPnOSHuDz45w6Mcn8KDStnn7lfP7mq8';
const VAPID_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbFJU7kK/6qirTXKT
EV2vcNUnoT/3urwMbRM+fqOGvEehRANCAASHGilhqdsMvg36gh7YypX942jzD36n
r2scSsQ6hJPZlVqusOmjTxhviCT5zkh7g8+OcOjHJ/Cg0rZ5+5Xz+5qv
-----END PRIVATE KEY-----`;
const SUB_MAIL = 'mailto:soporte.dragoexpres@gmail.com';
// escalar privado crudo (32 bytes) desde el PEM, via JWK: asi ECDH siempre recibe la clave correcta
const VAPID_PRIV_RAW = Buffer.from(crypto.createPrivateKey({ key: VAPID_PEM, format: 'pem' }).export({ format: 'jwk' }).d, 'base64url');


const b64d = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function joseSig(der) {
  // DER -> JOSE (r||s, 32 bytes cada uno)
  let i = 2, rlen = der[i]; let r = der.slice(i + 2, i + 2 + rlen); i += 2 + rlen;
  let slen = der[i]; let s = der.slice(i + 2, i + 2 + slen);
  const pad = (b) => { while (b.length < 32) b = Buffer.concat([Buffer.from([0]), b]); return b; };
  return Buffer.concat([pad(r), pad(s)]);
}

async function sendPush(sub, obj) {
  const payload = JSON.stringify(obj);
  // ---- encriptacion aes128gcm ----
  const uaPub = b64d(sub.keys.p256dh);
  const auth = b64d(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(VAPID_PRIV_RAW);
  const secret = ecdh.computeSecret(uaPub);
  const salt = crypto.randomBytes(16);
  const ikm = Buffer.concat([secret, auth]);
  const prk = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('WebPush: aes128gcm'), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', prk, Buffer.alloc(16, 0), Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', prk, Buffer.alloc(12, 0), Buffer.from('Content-Encoding: nonce\0'), 12));
  const pt = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  const keyid = Buffer.from('p');
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  const body = Buffer.concat([salt, rs, Buffer.from([keyid.length]), keyid, ct]);
  // ---- JWT VAPID ES256 ----
  const hdr = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const endpoint = new URL(sub.endpoint);
  const pl = Buffer.from(JSON.stringify({ aud: endpoint.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUB_MAIL })).toString('base64url');
  const signer = crypto.createSign('SHA256'); signer.update(hdr + '.' + pl);
  const jwt = hdr + '.' + pl + '.' + joseSig(signer.sign(VAPID_PEM)).toString('base64url');
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '3600',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': 'vapid t=' + jwt + ', k=' + VAPID_PUB,
      'Content-Length': body.length
    },
    body
  });
  return { status: r.status };
}

/* envia un push a un lote de suscripciones; devuelve cuantos se enviaron y limpia las que ya no existen (404/410) */
async function pushA(subs, obj) {
  let ok = 0, vivas = [];
  for (const s of (subs || [])) {
    try {
      const r = await sendPush(s, obj);
      if (r.status === 201 || r.status === 200) { ok++; vivas.push(s); }
      else if (r.status === 404 || r.status === 410) { /* suscripcion muerta: se descarta */ }
      else vivas.push(s);
    } catch (e) { try { vivas.push(s); } catch (e2) {} }
  }
  return { ok, vivas };
}

module.exports = { VAPID_PUB, sendPush, pushA };
