/**
 * What a pure function of a string made of the inputs it saw last,
 * kept so that one input is worked out once: for the decoding a vault
 * repeats over the same DIDs and keys on every read of its history.
 */

/** How many inputs a remembered function keeps the results of, unless told otherwise. */
export const REMEMBERED = 4096;

type Outcome<R> = { readonly result: R } | { readonly refusal: unknown };

/**
 * A pure function of a string that keeps what it made of the inputs it
 * saw last, so that one input is worked out once however often it is
 * asked for. Every caller of one input is handed the same result, which
 * must therefore be one nobody can change. A throw `refused` recognizes
 * is the input's own fault and is kept and thrown again; any other is
 * the moment's and is worked out anew. Past `limit` inputs the one kept
 * longest is forgotten, and works out to an equal result when it comes
 * again.
 */
export function remembered<R>(compute: (input: string) => R, refused: (error: unknown) => boolean, limit = REMEMBERED): (input: string) => R {
  const outcomes = new Map<string, Outcome<R>>();
  const keep = (input: string, outcome: Outcome<R>): void => {
    if (outcomes.size >= limit) outcomes.delete(outcomes.keys().next().value as string);
    outcomes.set(input, outcome);
  };
  return (input) => {
    const known = outcomes.get(input);
    if (known !== undefined) {
      if ("refusal" in known) throw known.refusal;
      return known.result;
    }
    let result: R;
    try {
      result = compute(input);
    } catch (error) {
      if (refused(error)) keep(input, { refusal: error });
      throw error;
    }
    keep(input, { result });
    return result;
  };
}

/** The value with every object and array in it frozen, itself included. */
export function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const member of Object.values(value)) frozen(member);
  }
  return value;
}
