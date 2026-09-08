async function settleMaybePromise(value) {
  try {
    if (value != null && typeof value.then === "function") {
      await value;
    }
  } catch {
    /* ignore close/release/rollback failures */
  }
}

module.exports = { settleMaybePromise };
