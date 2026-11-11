import "./loader/resolver.test.js";
import "./lexer/lexer.test.js";
import "./parser/parser.test.js";
import "./bytecode/bytecode.test.js";
import "./semantic-analyzer/semantic.test.js";
import "./vm/vm.test.js";
import "./integration/platform.test.js";
import "./integration/addendum.test.js";
import "./integration/modules.test.js";
import "./integration/builtins-types.test.js";
import "./integration/async-await.test.js";
import { runTests } from "./harness.js";

runTests();
