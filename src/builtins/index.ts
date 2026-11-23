/**
 * builtins/index.ts
 * ---------------------------------------------------------------------------
 * Built-in entry point. Side-effect imports run each module's registration
 * starts up or resolves an import.
 */

import "./modules/math.js";
import "./modules/os.js";
import "./modules/random.js";
import "./modules/sys.js";
import "./modules/test_sbk.js";
import "./modules/requests.js";
import "./modules/bytes.js";
import "./modules/fs.js";
export { getBuiltinModule, registerBuiltinModule } from "./registry.js";
export {
  getBuiltinGlobals,
  registerBuiltinGlobalFunction,
  registerBuiltinGlobalValue,
} from "./registry.js";
