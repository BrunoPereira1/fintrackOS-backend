import { Plan } from '../users/enums/plan.enum';

/** Ordem dos planos: um plano satisfaz todos os planos de nível menor ou igual. */
export const PLAN_HIERARCHY: Record<Plan, number> = {
  [Plan.BASIC]: 0,
  [Plan.INTERMEDIATE]: 1,
  [Plan.PREMIUM]: 2,
};

/** `true` se `userPlan` (padrão BASIC quando ausente) atende ao plano `required`. */
export function hasRequiredPlan(userPlan: Plan | null | undefined, required: Plan): boolean {
  return PLAN_HIERARCHY[userPlan ?? Plan.BASIC] >= PLAN_HIERARCHY[required];
}
