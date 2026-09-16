// Inert stand-ins for the handful of Vue reactivity helpers the vendored EE2 modules touch
// (RateLimiter, common.ts). Nothing here needs to be reactive: the port builds a query once per
// call and never renders. Shapes match Vue's ({ value } refs, identity for reactive wrappers).
'use strict'
const identity = (x) => x
const shallowRef = (v) => ({ value: v })
const computed = (getterOrOpts) => {
  const get = typeof getterOrOpts === 'function' ? getterOrOpts : getterOrOpts.get
  const set = typeof getterOrOpts === 'function' ? undefined : getterOrOpts.set
  return { get value() { return get() }, set value(v) { set && set(v) } }
}
module.exports = {
  ref: shallowRef, shallowRef, computed, triggerRef: () => {}, watch: () => () => {}, watchEffect: () => () => {},
  reactive: identity, shallowReactive: identity, readonly: identity, toRaw: identity, markRaw: identity, unref: (r) => (r && typeof r === 'object' && 'value' in r ? r.value : r),
}
