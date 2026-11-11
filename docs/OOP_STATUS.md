# THM OOP implementation status

## Implemented

- Multiple base classes in class declarations: `class D(B, C) { ... }`.
- C3 method resolution order (MRO), including inconsistent-MRO rejection.
- Cooperative zero-argument `super()` resolution through the MRO.
- `staticmethod`, `classmethod`, and `property` descriptors, including property
  setters and deleters.
- Custom descriptor lookup and mutation through `__get__`, `__set__`, and
  `__delete__`; `del object.attribute` invokes descriptor deletion when defined.
- Metaclass selection with `class C(Base, metaclass=Meta)`, inherited metaclass
  selection, and conflict detection.
- Metaclass `__new__` / `__init__` invocation with the class name, bases, and
  namespace. `type.__new__` and the three-argument `type(name, bases, namespace)`
  form create classes. Metaclass `__call__` is used when calling a class.
- Zero-argument `super()` follows the runtime instance/class MRO, including
  class methods.
- `isinstance()` and `issubclass()` use the MRO.
- Arithmetic operator dispatch through `__add__`, `__radd__`, `__sub__`, `__rsub__`,
  `__mul__`, `__rmul__`, division, modulo, power, bitwise and shift magic methods.
- Unary `__pos__`, `__neg__`, and `__invert__` dispatch.
- Rich comparison dispatch through `__eq__`, `__ne__`, `__lt__`, `__le__`, `__gt__`,
  and `__ge__`.

Metaclass `__prepare__` and full Python call/signature compatibility are not
implemented.

## Not implemented yet

- Full Python-compatible operator fallback semantics (`NotImplemented`, reflected
  precedence, and in-place operators).

Generic function and class decorators are now compiled and applied in Python order
(bottom-up). Regression coverage verifies decorator composition and class decoration.
