import { INTENTS, TIERS } from './feature-policy.mjs';
import { ID, MODEL_ID, RESERVED, fail, isObject } from './constants.mjs';

// Original implementation inspired by classifier.dev's separated dimensions.
// A five-level Score is zero-based on the wire; displayed difficulty is score + 1.
export const ROUTE_QUESTIONS = {
  intent: { type: 'choice', instructions: 'Classify the work actually required. Use other when the request is unclear or outside these categories.', criteria: {
    explain: 'Explain or locate existing code; do not change behavior', edit: 'Write or change a bounded piece of code or documentation',
    debug: 'Investigate the cause of a failure', operate: 'Operate infrastructure, deploy, or modify live data',
    research: 'Research information outside the repository', architecture: 'Cross-module design, whole-repository audit or major refactoring',
    other: 'Insufficient evidence or none of these intents' } },
  difficulty: { type: 'score', instructions: 'Estimate the reasoning needed to finish, not prompt length. Account for unresolved dependencies and unknown scope. Do not infer that a short request is easy.', criteria: [
    '1: Mechanical, exact edit with explicit location and no behavioral change',
    '2: Small local change with explicit requirements and known validation',
    '3: Moderate implementation requiring several related steps',
    '4: Difficult debugging or interacting components needing substantial investigation',
    '5: Deep reasoning, unknown repository-wide impact, architecture or long-horizon planning' ] },
  risk: { type: 'choice', instructions: 'Classify consequence and uncertainty, not permission. Safe requires evidence of local, reversible impact. Missing context is unknown. Risk is independent of difficulty.', criteria: {
    safe: 'Known local, reversible work with no security, production, payment or financial impact',
    caution: 'Material uncertainty or changes needing additional review',
    high: 'Irreversible operation, production, credentials, permissions, financial or payment consequences',
    unknown: 'Not enough context to assess impact' } },
};
function keys(value, allowed) {
  if (!isObject(value) || Object.keys(value).some(k => !allowed.includes(k) || RESERVED.has(k))) fail('INVALID_ROUTE_REQUEST');
}
export function validateRouteInput(input) {
  keys(input, ['task', 'host', 'risk', 'context', 'availableModels', 'availableSkills']);
  if (typeof input.task !== 'string' || !input.task.trim() || Buffer.byteLength(input.task) > 8000 ||
      !['codex', 'claude'].includes(input.host) || !['routine', 'sensitive'].includes(input.risk)) fail('INVALID_ROUTE_REQUEST');
  keys(input.context, ['complete', 'scope', 'previousFailures', 'highImpact', 'modelLocked', 'exhaustive']);
  const c = input.context;
  for (const key of ['complete', 'highImpact', 'modelLocked', 'exhaustive']) if (typeof c[key] !== 'boolean') fail('INVALID_ROUTE_REQUEST');
  if (!['local', 'cross-module', 'repository', 'unknown'].includes(c.scope) || !Number.isInteger(c.previousFailures) || c.previousFailures < 0 || c.previousFailures > 100) fail('INVALID_ROUTE_REQUEST');
  if (!Array.isArray(input.availableModels) || input.availableModels.length > 32 || new Set(input.availableModels).size !== input.availableModels.length ||
      input.availableModels.some(m => typeof m !== 'string' || !MODEL_ID.test(m))) fail('INVALID_ROUTE_REQUEST');
  const skills = input.availableSkills ?? [];
  if (!Array.isArray(skills) || skills.length > 128 || new Set(skills).size !== skills.length || skills.some(s => typeof s !== 'string' || !ID.test(s) || RESERVED.has(s))) fail('INVALID_ROUTE_REQUEST');
  return structuredClone({ ...input, availableSkills: skills });
}
export function routeGuard(input, policy) {
  const c = input.context;
  if (input.risk === 'sensitive' || c.highImpact) return 'SENSITIVE_SCOPE';
  if (c.modelLocked) return 'MODEL_LOCKED';
  if (c.exhaustive || c.scope === 'repository' || c.scope === 'cross-module') return 'SCOPE_REQUIRES_HOST';
  if (!c.complete || c.scope === 'unknown') return 'INCOMPLETE_CONTEXT';
  if (c.previousFailures > 0) return 'PRIOR_FAILURE';
  const targets = policy.profiles[input.host] ?? {};
  const available = new Set(Object.values(targets).map(t => t.model).filter(m => input.availableModels.includes(m)));
  return available.size < 2 ? 'INSUFFICIENT_TARGETS' : null;
}
export function routeRequest(input) {
  // Models, skill IDs and local policy are not sent to TypeSafe.
  return { purpose: 'route', risk: input.risk,
    state: { task: input.task, context: input.context }, questions: structuredClone(ROUTE_QUESTIONS) };
}
export function chooseRoute(answers, input, policy) {
  const { intent, difficulty, risk } = answers;
  if (!intent || !difficulty || !risk) return { reason: 'MISSING_DIMENSIONS' };
  const mean = difficulty.value + 1;
  const hardTail = (difficulty.probabilities['3'] ?? 0) + (difficulty.probabilities['4'] ?? 0);
  const deepTail = difficulty.probabilities['4'] ?? 0;
  const features = { intent: intent.value, difficulty: mean, hardTail, deepTail, risk: risk.value };
  // Check uncertainty and risk BEFORE cheap-route rules (unlike the source demo).
  if ([intent, difficulty, risk].some(a => a.confidence < policy.minConfidence) ||
      intent.selectedProbability < policy.minProbability || risk.selectedProbability < policy.minProbability) return { reason: 'UNCERTAIN_DIMENSIONS', features };
  if (intent.value === 'other' || (intent.probabilities.other ?? 0) > policy.maxUnknownProbability) return { reason: 'UNKNOWN_INTENT', features };
  if (risk.value !== 'safe' || (risk.probabilities.high ?? 0) > policy.maxRiskProbability ||
      (risk.probabilities.unknown ?? 0) > policy.maxUnknownProbability ||
      (risk.probabilities.caution ?? 0) > policy.maxUnknownProbability) return { reason: 'RISK_REQUIRES_HOST', features };
  if (['operate', 'architecture'].includes(intent.value)) return { reason: 'INTENT_REQUIRES_HOST', features };
  let tier = 'strong', rule = 'STRONG_DEFAULT';
  if (['explain', 'edit'].includes(intent.value) && mean <= policy.economyMaxDifficulty && hardTail <= policy.economyMaxHardProbability) {
    tier = 'economy'; rule = 'BOUNDED_EASY';
  } else if (intent.value !== 'debug' && mean <= policy.standardMaxDifficulty && deepTail <= policy.standardMaxDeepProbability) {
    tier = 'standard'; rule = 'BOUNDED_MODERATE';
  }
  const target = policy.profiles[input.host]?.[tier];
  if (!target || !input.availableModels.includes(target.model)) return { reason: 'TARGET_UNAVAILABLE', features };
  const skills = (target.skills?.[intent.value] ?? []).filter(id => input.availableSkills.includes(id));
  return { reason: rule, features, route: { tier, model: target.model, ...(target.reasoning ? { reasoning: target.reasoning } : {}), skills } };
}
export async function routeOrDelegate(layer, input, { use, delegate, signal } = {}) {
  if (typeof use !== 'function' || typeof delegate !== 'function') fail('HANDLERS_REQUIRED');
  const result = await layer.route(input, { signal });
  // Host still owns supported model/effort validation, execution, permissions and tests.
  return result.apply ? use(result.route, result) : delegate(result);
}
export const routeSchema = {
  type: 'object', additionalProperties: false, required: ['task', 'host', 'risk', 'context', 'availableModels'], properties: {
    task: { type: 'string', minLength: 1, maxLength: 8000 }, host: { type: 'string', enum: ['codex', 'claude'] },
    risk: { type: 'string', enum: ['routine', 'sensitive'] },
    context: { type: 'object', additionalProperties: false, required: ['complete', 'scope', 'previousFailures', 'highImpact', 'modelLocked', 'exhaustive'], properties: {
      complete: { type: 'boolean' }, scope: { type: 'string', enum: ['local', 'cross-module', 'repository', 'unknown'] },
      previousFailures: { type: 'integer', minimum: 0, maximum: 100 }, highImpact: { type: 'boolean' }, modelLocked: { type: 'boolean' }, exhaustive: { type: 'boolean' },
    } },
    availableModels: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string' }, description: 'Actual model IDs available to this host, not guessed names.' },
    availableSkills: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string' } },
  },
};
