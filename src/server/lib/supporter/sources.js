// How an unlock code reaches the app. Every source hands codes to the same
// deliver(code) -> Promise<{ok, reason}> (signature check in the main process),
// so the format and the checks never change between sources.
//
// Source interface: { name, start(deliver), stop() }
//
// Phase 1: ManualSource. The code is pasted on the phone remote.
// Phase 2 (not built): PollSource. After a Xendit QRIS payment, a Cloudflare
// Worker stores the signed code in KV under the device id. The app polls
// GET <worker>/code?did=<device id> every few minutes until it gets one, then
// calls deliver(code). Same code format, same verification.

function createManualSource() {
  let deliver = null;
  return {
    name: 'manual',
    start(d) { deliver = d; },
    stop() { deliver = null; },
    /** called for a code pasted on the phone */
    submit(code) {
      if (!deliver) return Promise.resolve({ ok: false, reason: 'unavailable' });
      return deliver(code, 'manual');
    },
  };
}

module.exports = { createManualSource };
