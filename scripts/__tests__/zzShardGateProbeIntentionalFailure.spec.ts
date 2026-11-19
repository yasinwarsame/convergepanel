// CI PROBE ONLY (draft PR, never to be merged): one intentionally failing
// suite, to prove a failing Jest shard turns the required Quality Gate red.
it("intentional failure for the shard-gate probe", () => {
  expect("probe").toBe("must fail");
});
