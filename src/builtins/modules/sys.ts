import { registerBuiltinModule } from "../registry.js";
import { ThmTypeError } from "../../errors/errors.js";
import { makeList, makeNone, isKind } from "../../runtime/values.js";

registerBuiltinModule("sys", {
  functions: {
    argv: (vm, _receiver, args) => {
      if (args.length !== 0) throw new ThmTypeError("argv() takes no arguments");
      const argv: string[] = [];
      for (const arg of vm.platform.args()) argv.push(arg);
      return makeList(vm.heap, argv);
    },
    path: (vm, _receiver, args) => {
      if (args.length !== 0) throw new ThmTypeError("path() takes no arguments");
      return vm.moduleSearchPaths();
    },
    exit: (vm, _receiver, args) => {
      if (args.length > 1) throw new ThmTypeError("exit() takes zero or one argument");
      let code = 0;
      if (args.length === 1 && !isKind(args[0]!, "none")) {
        const value = args[0]!;
        if (typeof value === "bigint") code = Number(value);
        else if (typeof value === "boolean") code = value ? 1 : 0;
        else if (typeof value === "number" && Number.isInteger(value)) code = value;
        else throw new ThmTypeError("exit() code must be an integer");
      }
      vm.platform.exit(code);
      return makeNone(vm.heap);
    },
  },
  values: {
    platform: "thm",
    version: "0.1.0",
  },
});
