/** A value that does not satisfy the profile's fact schema: wrong shape, a self-pair, or a successor or predecessor equal to an endpoint. */
export class InvalidFact extends Error {
  override readonly name = "InvalidFact";
}
