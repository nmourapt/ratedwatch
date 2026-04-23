// Public surface of the feature-flags domain module.

export { isEnabled, type FeatureFlagsEnv } from "./service";
export { evaluateRule } from "./evaluator";
export { parseRuleJson } from "./parse";
export { ruleSchema, type FlagRule, type FlagContext } from "./types";
