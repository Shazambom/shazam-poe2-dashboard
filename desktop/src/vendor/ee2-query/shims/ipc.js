// EE2's Host transport. The search path never reaches it; anything that does is a bug — throw
// loudly so a network call can never happen from the port (roadmap §4.5, zero network).
'use strict'
const dead = () => { throw new Error('ee2-query: network disabled') }
module.exports = { Host: { proxy: async () => dead(), sendEvent: () => {}, onEvent: () => new AbortController(), getConfig: async () => null, importFile: async () => '', logs: { value: '' }, version: { value: '0' }, updateInfo: { value: { state: 'initial' } }, isElectron: true } }
