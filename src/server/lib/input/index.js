// Real keyboard/mouse input for the OS, chosen per platform.
// Every backend implements the same small interface (see noop.js).
let impl;
try {
  if (process.platform === 'win32') impl = require('./win32');
  else if (process.platform === 'darwin') impl = require('./darwin');
} catch (e) {
  console.error('[input] native backend failed to load:', e.message);
}
if (!impl) impl = require('./noop');

module.exports = impl;
