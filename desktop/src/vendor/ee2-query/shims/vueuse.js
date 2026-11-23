// @vueuse/core's createGlobalState: memoise the factory once per process.
'use strict'
const createGlobalState = (factory) => {
  let state
  return () => {
    if (state === undefined) state = factory()
    return state
  }
}
module.exports = { createGlobalState }
