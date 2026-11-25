import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { REQUIRES_TIER_KEY } from '../decorators/requires-tier.decorator';
import { AuthGuard } from './auth.guard';
import { TierGuard } from './tier.guard';
import { Plan } from '../../users/enums/plan.enum';
import { CardsController } from '../../cards/cards.controller';
import { CardInvoicesController } from '../../cards/card-invoices.controller';
import { InstallmentsController } from '../../installments/installments.controller';
import { ReportsController } from '../../reports/reports.controller';
import { ContactsController } from '../../contacts/contacts.controller';
import { SplitsController } from '../../splits/splits.controller';

/**
 * Plano mínimo de cada rota (business-rules §1). Usuário rebaixado pode **ler** o que já tem e
 * **mudar status** (parcela paga / split recebido); criar, editar outros campos e remover exigem
 * o plano do recurso. `null` = sem exigência de plano (só autenticação).
 */
type Controller = new (...args: never[]) => object;
const ROUTES: [Controller, string, string, Plan | null][] = [
  [CardsController, 'findAll', 'GET /cards', null],
  [CardsController, 'findOne', 'GET /cards/:id', null],
  [CardsController, 'create', 'POST /cards', Plan.INTERMEDIATE],
  [CardsController, 'update', 'PATCH /cards/:id', Plan.INTERMEDIATE],
  [CardsController, 'remove', 'DELETE /cards/:id (arquiva)', Plan.INTERMEDIATE],
  [CardsController, 'restore', 'POST /cards/:id/restore', Plan.INTERMEDIATE],

  // Pagamento/encargo e desfazer: qualquer plano (D8 — exceção ao "rebaixado não cria")
  [CardInvoicesController, 'addPayment', 'POST .../invoices/:month/payments', null],
  [CardInvoicesController, 'removePayment', 'DELETE .../invoices/:month/payments/:id', null],
  [CardInvoicesController, 'addCharge', 'POST .../invoices/:month/charges', null],
  [CardInvoicesController, 'removeCharge', 'DELETE .../invoices/:month/charges/:id', null],

  [InstallmentsController, 'findAll', 'GET /installments', null],
  [InstallmentsController, 'findOne', 'GET /installments/:id', null],
  [InstallmentsController, 'update', 'PATCH /installments/:id (status)', null],

  [ReportsController, 'getInvoice', 'GET /reports/cards/:cardId/invoices/:month', null],
  [ReportsController, 'getMonthlySummary', 'GET /reports/monthly-summary/:month', null],
  [ReportsController, 'getReceivables', 'GET /reports/receivables', Plan.PREMIUM],

  [ContactsController, 'findAll', 'GET /contacts', null],
  [ContactsController, 'findOne', 'GET /contacts/:id', null],
  [ContactsController, 'create', 'POST /contacts', Plan.PREMIUM],
  [ContactsController, 'update', 'PATCH /contacts/:id', Plan.PREMIUM],
  [ContactsController, 'remove', 'DELETE /contacts/:id', Plan.PREMIUM],

  [SplitsController, 'findAll', 'GET /splits', null],
  [SplitsController, 'findOne', 'GET /splits/:id', null],
  [SplitsController, 'update', 'PATCH /splits/:id (status)', null],
  [SplitsController, 'create', 'POST /splits', Plan.PREMIUM],
  [SplitsController, 'remove', 'DELETE /splits/:id', Plan.PREMIUM],
];

const reflector = new Reflector();

/** Mesmo critério do TierGuard: metadata do método sobrepõe a da classe. */
function effectiveTier(cls: Controller, handler: string): Plan | null {
  const fn = (cls.prototype as Record<string, unknown>)[handler] as () => unknown;
  return reflector.getAllAndOverride<Plan>(REQUIRES_TIER_KEY, [fn, cls]) ?? null;
}

describe('plano mínimo por rota', () => {
  it.each(ROUTES)('%p.%s (%s) → %p', (cls, handler, _route, expected) => {
    expect(typeof (cls.prototype as Record<string, unknown>)[handler]).toBe('function');
    expect(effectiveTier(cls, handler)).toBe(expected);
  });

  it.each([
    CardsController,
    CardInvoicesController,
    InstallmentsController,
    ReportsController,
    ContactsController,
    SplitsController,
  ])('%p: sem @RequiresTier na classe e com AuthGuard + TierGuard', (cls) => {
    expect(Reflect.getMetadata(REQUIRES_TIER_KEY, cls)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, cls)).toEqual([AuthGuard, TierGuard]);
  });

  it('a tabela cobre todas as rotas dos controllers', () => {
    const controllers = [...new Set(ROUTES.map(([cls]) => cls))];
    for (const cls of controllers) {
      const handlers = Object.getOwnPropertyNames(cls.prototype).filter(
        (name) => name !== 'constructor',
      );
      const listed = ROUTES.filter(([c]) => c === cls).map(([, h]) => h);
      expect(handlers.sort()).toEqual(listed.sort());
    }
  });
});
