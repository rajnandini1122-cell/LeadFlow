import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServer as createTlsServer,
  type Server as TlsServer,
  type TLSSocket,
} from 'node:tls';
import { SMTPServer, type SMTPServerAddress, type SMTPServerSession } from 'smtp-server';

/**
 * Local mail servers for the e2e suites: a real SMTP server (smtp-server, the
 * library nodemailer is tested against) and a small scripted IMAP server. Both
 * speak implicit TLS with a certificate generated for this run, so every
 * connection the application makes is verified exactly as in production —
 * only the CA differs. Nothing here reaches the network.
 */

export const TEST_MAIL_HOST = 'mail.leadflow-test.example';

export interface TestCertificate {
  key: string;
  cert: string;
}

/** A self-signed certificate for TEST_MAIL_HOST, generated per run and never written to the repository. */
export function generateTestCertificate(hostname = TEST_MAIL_HOST): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), 'leadflow-mail-'));
  try {
    const result = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        `/CN=${hostname}`,
        '-addext',
        `subjectAltName=DNS:${hostname}`,
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr}`);
    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ReceivedMail {
  from: string;
  to: string[];
  raw: string;
}

export type RcptDecision = 'accept' | { code: number; message: string };
/** What the server does once the whole message has arrived. */
export type DataDecision = 'accept' | 'drop-connection' | { code: number; message: string };

export interface FakeSmtp {
  port: number;
  messages: ReceivedMail[];
  logins: number;
  onRcpt: (address: string) => RcptDecision;
  onData: (mail: ReceivedMail) => DataDecision;
  reset: () => void;
  close: () => Promise<void>;
}

export async function startFakeSmtp(
  tls: TestCertificate,
  credentials: { user: string; pass: string },
): Promise<FakeSmtp> {
  const state: FakeSmtp = {
    port: 0,
    messages: [],
    logins: 0,
    onRcpt: () => 'accept',
    onData: () => 'accept',
    reset: () => {
      state.messages.length = 0;
      state.logins = 0;
      state.onRcpt = () => 'accept';
      state.onData = () => 'accept';
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = new SMTPServer({
    secure: true,
    key: tls.key,
    cert: tls.cert,
    name: TEST_MAIL_HOST,
    authMethods: ['PLAIN', 'LOGIN'],
    size: 25 * 1024 * 1024,
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.username === credentials.user && auth.password === credentials.pass) {
        state.logins++;
        callback(null, { user: auth.username });
      } else {
        callback(Object.assign(new Error('Invalid username or password'), { responseCode: 535 }));
      }
    },
    onRcptTo(address: SMTPServerAddress, _session: SMTPServerSession, callback) {
      const decision = state.onRcpt(address.address);
      if (decision === 'accept') callback();
      else callback(Object.assign(new Error(decision.message), { responseCode: decision.code }));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const mail: ReceivedMail = {
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        };
        const decision = state.onData(mail);
        if (decision === 'drop-connection') {
          // The body arrived; the answer never does. The client cannot know.
          for (const socket of sockets) socket.destroy();
          return;
        }
        if (decision !== 'accept') {
          callback(Object.assign(new Error(decision.message), { responseCode: decision.code }));
          return;
        }
        state.messages.push(mail);
        callback(null, 'Queued as test');
      });
    },
  });
  server.on('error', () => undefined); // a client refusing our certificate is a test case, not a crash
  const sockets = new Set<{ destroy: () => void }>();
  // The raw socket of every client: destroying it is how "the answer never
  // comes" is simulated. ('connection' fires for the plain socket smtp-server
  // wraps in TLS itself.)
  server.server.on(
    'connection',
    (socket: { destroy: () => void; on: (e: string, f: () => void) => void }) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    },
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (server.server.address() as { port: number }).port;
  return state;
}

export interface FakeImapMessage {
  uid: number;
  source: string;
}

export interface FakeImap {
  port: number;
  uidValidity: number;
  messages: FakeImapMessage[];
  logins: number;
  /** Every command line received, credentials redacted. */
  commands: string[];
  close: () => Promise<void>;
}

/**
 * Enough IMAP4rev1 for imapflow: CAPABILITY, ID, LOGIN, LIST, EXAMINE/SELECT,
 * UID FETCH (UID, FLAGS, BODY.PEEK[]), NOOP, LOGOUT. Mutating commands are
 * answered NO and recorded, so a test can assert the application never sent one.
 */
export async function startFakeImap(
  tls: TestCertificate,
  credentials: { user: string; pass: string },
): Promise<FakeImap> {
  const state: FakeImap = {
    port: 0,
    uidValidity: 7,
    messages: [],
    logins: 0,
    commands: [],
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const open = new Set<TLSSocket>();

  const server: TlsServer = createTlsServer({ key: tls.key, cert: tls.cert }, (socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => undefined);
    let authed = false;
    let buffer = '';
    const send = (line: string) => socket.write(`${line}\r\n`);
    send('* OK [CAPABILITY IMAP4rev1 UIDPLUS] Fake IMAP ready');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
      }
    });

    const handle = (line: string) => {
      const match = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
      if (!match) return;
      const [, tag, rawCommand, rest = ''] = match;
      const command = rawCommand!.toUpperCase();
      state.commands.push(command === 'LOGIN' ? `${tag} LOGIN ***` : line);

      if (command === 'CAPABILITY') {
        send('* CAPABILITY IMAP4rev1 UIDPLUS');
        send(`${tag} OK CAPABILITY completed`);
      } else if (command === 'ID') {
        send('* ID NIL');
        send(`${tag} OK ID completed`);
      } else if (command === 'NOOP') {
        send(`${tag} OK NOOP completed`);
      } else if (command === 'LOGIN') {
        const args = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) =>
          (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'),
        );
        if (args[0] === credentials.user && args[1] === credentials.pass) {
          authed = true;
          state.logins++;
          send(`${tag} OK [CAPABILITY IMAP4rev1 UIDPLUS] LOGIN completed`);
        } else {
          send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        }
      } else if (!authed) {
        send(`${tag} BAD Not authenticated`);
      } else if (command === 'LIST' || command === 'LSUB') {
        if (/""\s*""$/.test(rest)) send('* LIST (\\Noselect) "/" ""');
        else if (/INBOX/i.test(rest)) send(`* ${command} (\\HasNoChildren) "/" INBOX`);
        send(`${tag} OK ${command} completed`);
      } else if (command === 'EXAMINE' || command === 'SELECT') {
        const uidNext = (state.messages.at(-1)?.uid ?? 0) + 1;
        send('* FLAGS (\\Seen \\Answered)');
        send(`* ${state.messages.length} EXISTS`);
        send('* 0 RECENT');
        send(`* OK [UIDVALIDITY ${state.uidValidity}] UIDs valid`);
        send(`* OK [UIDNEXT ${uidNext}] Predicted next UID`);
        send(
          `${tag} OK [${command === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${command} completed`,
        );
      } else if (command === 'UID' && /^FETCH /i.test(rest)) {
        const range = /^FETCH (\S+)/i.exec(rest)![1]!;
        const [startRaw, endRaw] = range.split(':');
        const start = Number(startRaw);
        const end = endRaw === '*' ? Number.MAX_SAFE_INTEGER : Number(endRaw ?? startRaw);
        let selected = state.messages.filter((m) => m.uid >= start && m.uid <= end);
        // RFC 3501: "n:*" always includes the highest UID, even when it is below n.
        if (selected.length === 0 && endRaw === '*' && state.messages.length > 0)
          selected = [state.messages.at(-1)!];
        // A partial fetch (BODY.PEEK[]<0.N>) is answered as BODY[]<0>, cut to N bytes.
        const partial = /BODY\.PEEK\[\]<0\.(\d+)>/i.exec(rest);
        for (const message of selected) {
          const seq = state.messages.indexOf(message) + 1;
          const full = Buffer.from(message.source, 'utf8');
          const body = partial ? full.subarray(0, Number(partial[1])) : full;
          socket.write(
            `* ${seq} FETCH (UID ${message.uid} FLAGS () BODY[]${partial ? '<0>' : ''} {${body.length}}\r\n`,
          );
          socket.write(body);
          socket.write(')\r\n');
        }
        send(`${tag} OK UID FETCH completed`);
      } else if (command === 'LOGOUT') {
        send('* BYE Logging out');
        send(`${tag} OK LOGOUT completed`);
        socket.end();
      } else {
        send(`${tag} NO Not supported by the fake server`);
      }
    };
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (server.address() as { port: number }).port;
  return state;
}
