import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('FinTrack OS API')
    .setDescription('FinTrack OS Pro Edition — REST API')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Firebase JWT',
        description: 'Firebase ID Token obtido via autenticação no frontend',
      },
      'firebase-jwt',
    )
    .addTag('auth', 'Autenticação via Firebase')
    .addTag('users', 'Gestão de usuários')
    .addTag('cards', 'Cartões de crédito')
    .addTag('transactions', 'Transações e itens')
    .addTag('installments', 'Parcelas')
    .addTag('splits', 'Divisão de custos')
    .addTag('contacts', 'Contatos para divisão de custos (Premium)')
    .addTag('assets', 'Investimentos')
    .addTag('ocr', 'Leitura de notas fiscais (Premium)')
    .addTag('reports', 'Visões: fatura do cartão, resumo mensal e quem me deve')
    .addTag('health', 'Health checks (liveness/readiness)')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}
