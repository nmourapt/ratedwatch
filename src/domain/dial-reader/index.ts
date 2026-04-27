// Public surface of the dial-reader domain module.
//
// `__setTestDialReader` is intentionally NOT re-exported here — it
// lives on the `adapter` module and must be imported directly by
// test files (`from "@/domain/dial-reader/adapter"`). That keeps
// the test escape hatch out of the production-code import surface.
export {
  readDial,
  type DialReadResult,
  type DialReadSuccessBody,
  type DialReader,
  type DialReaderEnv,
  type ReadDialContext,
} from "./adapter";
