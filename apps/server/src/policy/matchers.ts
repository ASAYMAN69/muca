/**
 * The argument matchers of a policy.
 *
 * A policy's `match` is a small JSON object of argument matchers, for
 * example:
 *
 * ```json
 * { "name": { "startsWith": "fix/" } }
 * ```
 *
 * The vocabulary is deliberately tiny — seven operations — because a
 * policy is something a person writes by hand, and every operation is
 * one they can predict.
 */

/** The operations a matcher supports. */
export type MatcherOperation =
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith'
  | 'contains'
  | 'matches'
  | 'in';

/** One matcher: an operation and its operand. */
export type Matcher = { [K in MatcherOperation]?: unknown };

/**
 * A matcher value.
 *
 * An **object** is an AND: every operation in it must hold. An **array**
 * is an OR: one of its elements must hold. A bare value is shorthand for
 * `{ equals: value }`.
 */
export type MatcherValue = Matcher | Matcher[] | string | number | boolean | null;

/** The whole `match` object: one matcher per argument name. */
export type MatchObject = Record<string, MatcherValue>;

/**
 * Whether a value equals another.
 *
 * Objects and arrays are compared structurally, so two policies that
 * spell the same list the same way match. Everything else is compared by
 * type and value, so `"1"` never equals `1`.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEquals(item, b[index]));
  }

  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aEntries = Object.entries(a as Record<string, unknown>);
    const bEntries = Object.entries(b as Record<string, unknown>);
    if (aEntries.length !== bEntries.length) return false;
    return aEntries.every(([key, value]) =>
      deepEquals(value, (b as Record<string, unknown>)[key]),
    );
  }

  return false;
}

/**
 * Applies one operation to one value.
 *
 * A value that is not there (`undefined`) only satisfies `notEquals`:
 * "this argument is not X" is true when the argument is absent.
 */
export function applyOperation(
  operation: MatcherOperation,
  operand: unknown,
  value: unknown,
): boolean {
  switch (operation) {
    case 'equals':
      return value !== undefined && deepEquals(value, operand);

    case 'notEquals':
      return !deepEquals(value, operand);

    case 'startsWith':
      return (
        typeof value === 'string' &&
        typeof operand === 'string' &&
        value.startsWith(operand)
      );

    case 'endsWith':
      return (
        typeof value === 'string' &&
        typeof operand === 'string' &&
        value.endsWith(operand)
      );

    case 'contains':
      if (Array.isArray(value)) {
        return value.some((item) => deepEquals(item, operand));
      }
      if (typeof value === 'string' && typeof operand === 'string') {
        return value.includes(operand);
      }
      return false;

    case 'matches':
      if (typeof value !== 'string' || typeof operand !== 'string') return false;
      try {
        return new RegExp(operand).test(value);
      } catch {
        // A pattern that is not a valid regular expression never matches.
        // It must not take the whole request down.
        return false;
      }

    case 'in':
      if (!Array.isArray(operand)) return false;
      return operand.some((item) => deepEquals(value, item));

    default:
      return false;
  }
}

/**
 * Applies one matcher value to one argument value.
 *
 * An object is an AND, an array is an OR, and a bare value is `equals`.
 */
export function matchesValue(matcher: MatcherValue, value: unknown): boolean {
  if (Array.isArray(matcher)) {
    return matcher.some((element) => matchesValue(element, value));
  }

  if (
    matcher !== null &&
    typeof matcher === 'object' &&
    !Array.isArray(matcher)
  ) {
    const entries = Object.entries(matcher as Matcher).filter(
      ([operation]) => operation in OPERATION_NAMES,
    ) as Array<[MatcherOperation, unknown]>;
    if (entries.length === 0) return false;
    return entries.every(([operation, operand]) =>
      applyOperation(operation, operand, value),
    );
  }

  return applyOperation('equals', matcher, value);
}

/** The operations that exist, used to filter out typos. */
const OPERATION_NAMES: Record<MatcherOperation, true> = {
  equals: true,
  notEquals: true,
  startsWith: true,
  endsWith: true,
  contains: true,
  matches: true,
  in: true,
};

/**
 * Whether a call's arguments satisfy a policy's `match`.
 *
 * Every argument the policy mentions must match. An argument the policy
 * does not mention is ignored, so a policy that only mentions `name`
 * applies to a call whatever else it passes.
 */
export function matchesArguments(
  match: MatchObject | null | undefined,
  args: Record<string, unknown>,
): boolean {
  if (!match) return true;

  for (const [name, matcher] of Object.entries(match)) {
    if (!matchesValue(matcher, args[name])) return false;
  }

  return true;
}
