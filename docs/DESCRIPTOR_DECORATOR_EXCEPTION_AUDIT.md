# Custom descriptor and decorator exception audit

## Scope

Audited exception propagation for custom descriptor callbacks (`__get__`, `__set__`, `__delete__`) and decorator callbacks, including nested calls and recursive wrappers.

## Results

The VM's callback-boundary hand-off in `invokeCallback()` and `dispatchException()` correctly preserves an exception when a handler exists outside the callback frame. The callback rethrows the original THM exception at the call site, allowing the caller's normal instruction dispatcher to route it to the surrounding handler.

Regression coverage added:

- `__get__`, `__set__`, and `__delete__` each raising through a nested helper call and being caught by the accessing/assigning/deleting caller.
- Original exception type and message preserved when custom descriptor exceptions are unhandled.
- Decorator failure while decorating a function.
- Decorator factory failure while evaluating a decorator expression.
- Class decorator failure.
- Recursive wrapper calls that ultimately raise, with the exception caught by the wrapper caller.
- Original exception type and message preserved for an unhandled wrapper exception.

## Test result

The complete project test suite plus these additional regression cases passed: **103 passed, 0 failed**.

The TypeScript sources were emitted with the available TypeScript 5.8.3 compiler using temporary ambient Node.js declarations because this environment does not have `@types/node`. The emitted test suite ran under Node.js 22.16.0. The project's `scriptc` build was not run: the package requires Node.js >=24 and the available environment is Node.js 22.16.0.

No runtime code changes were required by this audit. The additional tests are retained in `tests/vm/vm.test.ts` so the cases remain covered in future changes.
