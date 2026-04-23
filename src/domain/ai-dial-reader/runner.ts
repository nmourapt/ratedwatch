// Thin indirection between the AI dial reader and the actual Workers
// AI binding. Lets integration tests override the "AI runner" with a
// canned fake without having to plumb an alternate binding through
// miniflare (AI bindings always resolve remotely, which the pool
// treats specially).
//
// Semantics:
//
//   * Production path: `resolveAiRunner(env)` returns a function that
//     delegates straight to `env.AI.run(DIAL_MODEL, inputs)`.
//
//   * Test path: the integration-test file imports `__setTestAiRunner`
//     and installs a stub that returns a canned response. Because
//     vitest-pool-workers runs the Worker and the tests in the same
//     workerd process per test file, module-level state is shared —
//     this works without any miniflare binding override.
//
// The production code never touches `__setTestAiRunner` and never
// reads the module-level `testRunner` ref directly. The only place
// that matters is `resolveAiRunner`, which routes to the fake when
// one is installed.

export const DIAL_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export interface AiRunInputs {
  /**
   * JPEG bytes as a plain number array, per the Workers AI vision
   * input schema. A `Uint8Array` also works at runtime but the
   * documented contract is `number[]`.
   */
  image: number[];
  prompt: string;
}

export interface AiRunResponse {
  // The Workers AI vision model returns `{ response: string }`. We
  // defensively type it as optional so a malformed upstream response
  // can be handled at the reader layer instead of blowing up here.
  response?: string;
}

export type AiRunner = (inputs: AiRunInputs) => Promise<AiRunResponse>;

export interface AiRunnerEnv {
  AI: Ai;
}

// Test-only module-level override. `null` ⇒ use the real env.AI.
let testRunner: AiRunner | null = null;

/**
 * TEST-ONLY. Install a fake AI runner that every call to
 * `resolveAiRunner` returns until cleared. Call with `null` in a
 * test teardown hook to restore the default.
 *
 * Deliberately not exported from index.ts — this lives under the
 * runner module and must be imported directly by the test file that
 * uses it. That keeps accidental production calls close to impossible.
 */
export function __setTestAiRunner(fn: AiRunner | null): void {
  testRunner = fn;
}

/**
 * Resolve the effective AI runner for this request. When a test has
 * installed a fake via `__setTestAiRunner`, return that; otherwise
 * delegate to `env.AI.run` with the dial-reader model.
 */
export function resolveAiRunner(env: AiRunnerEnv): AiRunner {
  if (testRunner) return testRunner;
  return async (inputs) => {
    // The Ai binding's type signature is a cross-product over every
    // model's input/output shape — TypeScript can't narrow without
    // knowing the model key. Cast here; the vision model is called
    // with `{ image, prompt }` and returns `{ response }`.
    const res = (await (
      env.AI as unknown as {
        run: (model: string, inputs: AiRunInputs) => Promise<AiRunResponse>;
      }
    ).run(DIAL_MODEL, inputs)) as AiRunResponse;
    return res;
  };
}
