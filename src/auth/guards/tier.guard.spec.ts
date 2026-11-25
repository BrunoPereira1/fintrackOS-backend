import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TierGuard } from './tier.guard';
import { RequiresTier } from '../decorators/requires-tier.decorator';
import { Plan } from '../../users/enums/plan.enum';
import { ErrorMessages } from '../../common/constants/error-messages';

@RequiresTier(Plan.PREMIUM)
class ClassLevelController {
  inherits() {}

  @RequiresTier(Plan.INTERMEDIATE)
  overridden() {}
}

class NoMetadataController {
  open() {}

  @RequiresTier(Plan.INTERMEDIATE)
  restricted() {}
}

function contextFor(cls: new () => object, handler: string, plan?: Plan | null): ExecutionContext {
  return {
    getHandler: () => (cls.prototype as Record<string, unknown>)[handler],
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user: plan === undefined ? {} : { plan } }) }),
  } as unknown as ExecutionContext;
}

describe('TierGuard', () => {
  const guard = new TierGuard(new Reflector());

  it('sem metadata: libera qualquer plano (inclusive usuário sem plano)', () => {
    expect(guard.canActivate(contextFor(NoMetadataController, 'open'))).toBe(true);
    expect(guard.canActivate(contextFor(NoMetadataController, 'open', Plan.BASIC))).toBe(true);
  });

  it('metadata no método: plano suficiente passa (igual ou maior)', () => {
    expect(
      guard.canActivate(contextFor(NoMetadataController, 'restricted', Plan.INTERMEDIATE)),
    ).toBe(true);
    expect(guard.canActivate(contextFor(NoMetadataController, 'restricted', Plan.PREMIUM))).toBe(
      true,
    );
  });

  it('metadata no método: plano insuficiente → 403 PLAN_REQUIRED', () => {
    expect(() =>
      guard.canActivate(contextFor(NoMetadataController, 'restricted', Plan.BASIC)),
    ).toThrow(new ForbiddenException(ErrorMessages.PLAN_REQUIRED(Plan.INTERMEDIATE)));
  });

  it('usuário sem plano é tratado como basic', () => {
    expect(() => guard.canActivate(contextFor(NoMetadataController, 'restricted', null))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(contextFor(NoMetadataController, 'restricted'))).toThrow(
      ForbiddenException,
    );
  });

  it('metadata na classe vale para métodos sem metadata própria', () => {
    expect(() =>
      guard.canActivate(contextFor(ClassLevelController, 'inherits', Plan.INTERMEDIATE)),
    ).toThrow(new ForbiddenException(ErrorMessages.PLAN_REQUIRED(Plan.PREMIUM)));
    expect(guard.canActivate(contextFor(ClassLevelController, 'inherits', Plan.PREMIUM))).toBe(
      true,
    );
  });

  it('metadata no método sobrepõe a da classe', () => {
    expect(
      guard.canActivate(contextFor(ClassLevelController, 'overridden', Plan.INTERMEDIATE)),
    ).toBe(true);
    expect(() =>
      guard.canActivate(contextFor(ClassLevelController, 'overridden', Plan.BASIC)),
    ).toThrow(new ForbiddenException(ErrorMessages.PLAN_REQUIRED(Plan.INTERMEDIATE)));
  });
});
