import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppConfig } from './common/config/config.module';

/**
 * HTTP entrypoint.
 *
 * The worker runs the same modules from src/worker.ts as a separate process,
 * so both share one Prisma client, one domain layer and one tenant-context
 * implementation while scaling independently (spec §27).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    /*
     * Keeps the exact bytes of each request body alongside the parsed one.
     *
     * Required by the WhatsApp webhook: Meta signs the raw payload, and any
     * re-serialisation of the parsed JSON — key order, unicode escaping,
     * whitespace — produces a different HMAC and rejects a legitimate message.
     * Verifying a re-encoded body is the classic way a signature check ends up
     * validating nothing.
     */
    rawBody: true,
  });

  app.useLogger(app.get(Logger));
  const config = app.get(AppConfig);

  app.use(helmet());
  app.use(cookieParser());

  // Express defaults to 100kb, which a few hundred imported leads exceed.
  // Raised to just above the CSV cap the import DTO enforces, and no further:
  // the body limit is the only thing standing between an unauthenticated
  // request and an arbitrarily large allocation.
  app.useBodyParser('json', { limit: '3mb' });

  // Behind a load balancer, req.ip must come from X-Forwarded-For or every
  // rate limit and audit entry records the proxy's address instead of the
  // client's. `1` trusts exactly one hop — trusting all would let a client
  // spoof its own IP by setting the header.
  app.set('trust proxy', 1);

  app.setGlobalPrefix('api', { exclude: ['health', 'readiness'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // Reject unknown properties outright rather than silently dropping them,
      // so a client sending a field we do not support learns about it.
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableCors({
    origin: config.get('CORS_ORIGINS'),
    credentials: true, // required for the httpOnly refresh cookie
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // API docs are a map of the attack surface; they stay out of production.
  if (!config.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('LeadFlow API')
        .setDescription('WhatsApp-first sales CRM for Indian SMEs')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  // Let in-flight requests finish before the process exits during a deploy.
  app.enableShutdownHooks();

  const port = config.get('PORT');
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`LeadFlow API listening on :${port} [${config.get('NODE_ENV')}]`);
  if (!config.isProduction) logger.log(`API docs at http://localhost:${port}/api/docs`);
}

void bootstrap();
