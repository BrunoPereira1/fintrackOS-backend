import { SetMetadata } from '@nestjs/common';
import { Plan } from '../../users/enums/plan.enum';

export const REQUIRES_TIER_KEY = 'requires_tier';
export const RequiresTier = (plan: Plan) => SetMetadata(REQUIRES_TIER_KEY, plan);
