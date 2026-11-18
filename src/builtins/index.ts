// Import each built-in module here so registration runs before VM imports.
import "./modules/math.js";
import "./modules/os.js";
import "./modules/random.js";
import "./modules/sys.js";
import "./modules/test_sbk.js";
import "./modules/requests.js";
import "./modules/bytes.js";
// import {addSearchPath} from "./../loader/resolver.js";
export { getBuiltinModule, registerBuiltinModule } from "./registry.js";
export {
  getBuiltinGlobals,
  registerBuiltinGlobalFunction,
  registerBuiltinGlobalValue,
} from "./registry.js";
