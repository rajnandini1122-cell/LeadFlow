// Shows the TLS certificate a PostgreSQL endpoint presents. Handshake only: no login, no SQL.
// Usage: node scripts/inspect-db-tls.cjs acela.proxy.rlwy.net 17722
const net = require('node:net'), tls = require('node:tls'), crypto = require('node:crypto');
const [host, port] = [process.argv[2], Number(process.argv[3])];
const sock = net.connect(port, host, () => {
  const req = Buffer.alloc(8); req.writeInt32BE(8, 0); req.writeInt32BE(80877103, 4); sock.write(req);
});
sock.once('data', (b) => {
  console.log('server answered SSLRequest with:', b.toString('latin1', 0, 1), b[0] === 0x53 ? '(TLS supported)' : '(no TLS)');
  if (b[0] !== 0x53) return sock.end();
  const t = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
    const c = t.getPeerCertificate(true);
    const chain = []; let x = c; const seen = new Set();
    while (x && !seen.has(x.fingerprint256)) { seen.add(x.fingerprint256); chain.push(x); x = x.issuerCertificate; }
    console.log('protocol:', t.getProtocol(), '| cipher:', t.getCipher().name);
    console.log('trusted by Node/OS public CAs:', t.authorized, t.authorizationError ? `(${t.authorizationError})` : '');
    for (const [i, k] of chain.entries()) console.log(`cert[${i}] subject=${JSON.stringify(k.subject)} issuer=${JSON.stringify(k.issuer)} SAN=${k.subjectaltname ?? '-'} valid=${k.valid_from} → ${k.valid_to} sha256=${k.fingerprint256}`);
    const hostOk = tls.checkServerIdentity(host, c);
    console.log('hostname matches certificate:', hostOk ? `NO (${hostOk.reason})` : 'yes');
    t.end();
  });
  t.on('error', (e) => console.log('TLS error:', e.message));
});
sock.on('error', (e) => console.log('socket error:', e.message));
