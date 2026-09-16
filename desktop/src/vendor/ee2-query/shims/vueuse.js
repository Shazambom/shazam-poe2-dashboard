// @vueuse/core's createGlobalState: memoise the factory once per process.
'use strict'
const createGlobalState = (factory) => { let state; return () => (state === undefined ? (state = factory()) : state) }
module.exports = { createGlobalState }
