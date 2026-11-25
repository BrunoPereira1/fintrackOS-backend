import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { isSwaggerEnabled, parseTrustProxy, setupSwagger } from './config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Atrás de load balancer/proxy, req.ip (usado pelo throttler) precisa vir do X-Forwarded-For.
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== false) app.set('trust proxy', trustProxy);

  // Os defaults do helmet (CSP inclusa) são compatíveis com o Swagger UI do @nestjs/swagger:
  // scripts vêm de arquivos próprios em /docs ('self') e os <style> inline já são permitidos.
  // Fora de produção a API roda em HTTP puro, então não pedimos upgrade para HTTPS
  // (alguns navegadores aplicariam isso até em localhost/IP da rede e quebrariam o /docs).
  const isProduction = process.env.NODE_ENV === 'production';
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { upgradeInsecureRequests: isProduction ? [] : null },
      },
    }),
  );

  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerEnabled = isSwaggerEnabled(process.env);
  if (swaggerEnabled) setupSwagger(app);

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`Application running on http://localhost:${port}`);
  if (swaggerEnabled) logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

void bootstrap();
