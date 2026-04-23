// Public surface of the feature-flags domain module.

export { isEnabled, type FeatureFlagsEnv } from "./service";
export { evaluateRule } from "./evaluator";
export { ruleSchema, type FlagRule, type FlagContext } from "./types";
