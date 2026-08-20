import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

/**
 * Background worker entrypoint.
 *
 * Deployed as a SEPARATE PROCESS from the API (spec §27) but built from the
 * same codebase, so queue processors reuse the same repositories, the same
 * Prisma tenant scoping and the same domain rules as HTTP handlers. Splitting
 * this into its own workspace would have meant duplicating all three.
 *
 * `createApplicationContext` starts the DI container WITHOUT an HTTP listener —
 * the worker binds no port and serves no traffic.
 *
 * Phase 1 boots the container and holds. Phase 6 registers the BullMQ
 * processors listed in spec §11 (FOLLOW_UP, NOTIFICATION, WHATSAPP,
 * WEBHOOK_PROCESSOR, IMPORT, REPORT).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const logger = app.get(Logger);
  logger.log('LeadFlow worker started — no queue processors registered until Phase 6');

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, shutting down worker`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap();
