export type { InstrumentOptions, InstrumentResult } from "@rootray/jsx-instrument";
export {
  ATTR_COLUMN,
  ATTR_COMPONENT,
  ATTR_FILE,
  ATTR_LINE,
  instrumentSource,
  relativeSourcePath,
  shouldInstrument,
} from "@rootray/jsx-instrument";
export type { RootRayInspectorOptions } from "./plugin.js";
export { default, RUNTIME_URL } from "./plugin.js";
