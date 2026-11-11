# Property callback exception handling

Property getter, setter, and deleter callbacks now preserve the original THM
exception when it must unwind from the callback frame into a caller's
`try/except` handler.

The VM tracks active `invokeCallback()` boundaries. If exception dispatch finds
a handler outside the callback's frame, it records the original exception on
the corresponding boundary. Once the callback frame has been unwound,
`invokeCallback()` rethrows that same exception at the callback call site. The
caller instruction dispatcher can then route it through the caller's handler
without replacing it with a generic `RuntimeError`.

Regression coverage includes:

- Exceptions raised directly by property getters, setters, and deleters.
- Exceptions raised by a nested function called from a property callback.
- Preservation of the original exception type and message when unhandled.
