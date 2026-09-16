// The one place the vendored port is required from. main.js never requires this or the vendor —
// only the worker does (pinned by ee2-query-bundle.test.mjs).
'use strict'
module.exports = require('../vendor/ee2-query')
