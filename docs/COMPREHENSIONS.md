# THM Comprehensions

THM supports Python-style list, set, and dictionary comprehensions.

```thm
numbers = [1, 2, 3, 4, 5]

# List comprehension
squares = [x * x for x in numbers]
evens = [x for x in numbers if x % 2 == 0]

# Multiple for clauses (nested iteration)
pairs = [(x, y) for x in [1, 2] for y in [10, 20]]

# Set comprehension (duplicate values are removed)
remainders = {x % 2 for x in numbers}

# Dictionary comprehension
square_map = {x: x * x for x in numbers if x > 2}

# Tuple-unpacking target
coordinates = [(1, 2), (3, 4)]
totals = [x + y for x, y in coordinates]
```

Implementation notes:

- Comprehensions are compiled to the existing iterator and jump bytecode plus dedicated collection insertion opcodes.
- `if` clauses filter values before the innermost expression is evaluated.
- Multiple `for` clauses execute as nested loops, in source order.
- Comprehension iteration variables use compiler-generated local bindings and do not overwrite variables in the surrounding scope.
- Dictionary keys use the runtime's normal dictionary hashing/equality rules; set entries use the runtime's normal set uniqueness rules.
