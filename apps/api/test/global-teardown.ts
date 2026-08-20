import type { PGlite } from '@electric-sql/pglite';
import type { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export default async function globalTeardown(): Promise<void> {
  const globals = globalThis as { __PGLITE__?: { server: PGLiteSocketServer; db: PGlite } };
  const handles = globals.__PGLITE__;
  if (!handles) return;

  await handles.server.stop();
  await handles.db.close();
}
