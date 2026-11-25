import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRES_TIER_KEY } from '../decorators/requires-tier.decorator';
import { Plan } from '../../users/enums/plan.enum';
import { hasRequiredPlan } from '../plan-access';
import { ErrorMessages } from '../../common/constants/error-messages';

@Injectable()
export class TierGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredTier = this.reflector.getAllAndOverride<Plan>(REQUIRES_TIER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredTier) return true;

    const { user } = context.switchToHttp().getRequest<{ user: { plan?: Plan } }>();

    if (!hasRequiredPlan(user?.plan, requiredTier)) {
      throw new ForbiddenException(ErrorMessages.PLAN_REQUIRED(requiredTier));
    }

    return true;
  }
}
