/** A fact that does not satisfy the profile's schema: wrong shape, a self-pair, a successor equal to an endpoint, or a second value under a key already given. */
export class InvalidFact extends Error {
  override readonly name = "InvalidFact";
}
