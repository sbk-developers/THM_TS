import { ThmTypeError } from "../../errors/errors.js";
import { registerBuiltinModule } from "../registry.js";

registerBuiltinModule("test_sbk", {
  values: { author: "SBK" },
  functions: {
    greet: (_vm, _receiver, args) => {
      if (args.length > 1) throw new ThmTypeError("greet() accepts zero or one argument");
      if (args.length === 1 && typeof args[0] !== "string") {
        throw new ThmTypeError("greet() name must be a string");
      }
      const name = args.length === 0 ? "world" : args[0];
      return `Hello, ${name}!`;
    },
  },
});
