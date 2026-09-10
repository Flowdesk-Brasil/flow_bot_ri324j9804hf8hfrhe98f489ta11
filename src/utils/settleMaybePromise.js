async function settleMaybePromise(value) {
  try {
    await value;
  } catch {
    /* ignore close/release/rollback failures — never call .catch on a maybe-undefined value */
  }
}

module.exports = { settleMaybePromise };
