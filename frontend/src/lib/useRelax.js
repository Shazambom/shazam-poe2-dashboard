// Feature 3: "Close-enough" fuzzy rare finder hook for Trading → Workspace and ExiledExchange2 History.
// Ephemeral overlay over the active search: never mutates node.q or node.slug in workspaceStore.
// Reuses TAP data exposed by useReprice without duplicating listeners, and cancels on row/tab switch.
import { ignoredError } from './ignoredError.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, toast } from './api.js'
import { diag } from './diag.js'
import { connectSession, queryUrl, searchOfLink, tradeUrl } from './session.js'
import { useStatus } from './statusStore.js'
import {
  parseNodeQuery,
  relaxPreview,
  relaxQuery,
  applyRelaxedCurrency,
  bestRelaxedCurrency,
} from './relaxQuery.js'

const IDLE = Object.freeze({
  status: 'idle',
  level: 0,
  summary: null,
  relaxUrl: null,
  authRequired: false,
  authLevel: null,
})

function relaxErrorLabel(err) {
  if (err === 'rate') return 'Rate limited — try again shortly'
  if (err === 'auth') return 'Connect your PoE session to broaden this search'
  if (err === 'bad request') return 'Could not broaden this search'
  return 'Could not broaden search — try again'
}

export function useRelax({
  node,
  league,
  visible = true,
  remountKey,
  page = null,
  rowQuery = null,
  prices = null,
  options = null,
  emptyExact = false,
}) {
  const nodeId = node?.id ?? null
  const [st, setSt] = useState(() => ({ ...IDLE, relaxTick: 0 }))
  const [connecting, setConnecting] = useState(false)
  const [decodedSlug, setDecodedSlug] = useState(null)
  const decodedSlugQuery = decodedSlug?.nodeId === nodeId ? decodedSlug.query : null
  // A TAP search object belongs to one observed search; fetches only replace its rows.
  // The outgoing webview can still expose its relaxed search after another row is selected.
  const search = page?.search
  const [relaxedSearch, setRelaxedSearch] = useState(null)
  const mountedRef = useRef(true)
  const reqRef = useRef(0)
  const baseQueryRef = useRef(null) // { nodeId, query } | null
  const stalePageIdRef = useRef(null)
  const prevNodeIdRef = useRef(nodeId)
  const pageIdRef = useRef(null)
  pageIdRef.current = page?.search?.id ?? null
  const stRef = useRef(st)
  stRef.current = st

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Synchronous query extraction for EE2 History & item-built nodes (node.q already present).
  const nodeQuery = useMemo(() => parseNodeQuery(node), [node?.q, node?.degraded])

  // Async fallback for saved slug searches that don't store node.q.
  useEffect(() => {
    let live = true
    setDecodedSlug(null)
    if (nodeQuery || !node || node.kind !== 'search' || node.live || !node.slug) return () => { live = false }
    searchOfLink(tradeUrl(node, league, false))
      .then(j => { if (live && j?.query) setDecodedSlug({ nodeId, query: j.query }) })
      .catch(() => ignoredError('read trade search'))
    return () => { live = false }
  }, [nodeId, node?.slug, node?.kind, node?.live, league, nodeQuery])

  // Clear snapshot when switching rows; cancel in-flight check on row switch, reload, league change, or leaving Workspace.
  // If a relaxed ?q= webview was mounted, also bump relaxTick and blacklist its TAP page id so any in-flight
  // trade-site redirect cannot overwrite the saved node.slug or poison baseQueryRef.
  useEffect(() => {
    const nodeChanged = prevNodeIdRef.current !== nodeId
    if (nodeChanged) {
      prevNodeIdRef.current = nodeId
      baseQueryRef.current = null
      stalePageIdRef.current = null
    }
    reqRef.current += 1
    setSt(prev => {
      if (prev.status === 'idle' && prev.level === 0 && !prev.relaxUrl && !prev.authRequired) return prev
      if (!nodeChanged && prev.relaxUrl) stalePageIdRef.current = pageIdRef.current
      return { ...IDLE, relaxTick: prev.relaxUrl ? prev.relaxTick + 1 : prev.relaxTick }
    })
    return () => {
      reqRef.current += 1
      window.poe2desktop?.trade?.relaxCancel?.()
    }
  }, [nodeId, league, visible, remountKey])

  const liveEligibleNode = !!node && node.kind === 'search' && !node.live
  if (st.relaxUrl && st.relaxedNodeId === nodeId && search && search !== relaxedSearch) {
    setRelaxedSearch(search)
  }
  const livePageQuery = search !== relaxedSearch && search?.id != null && search.id !== stalePageIdRef.current
    ? (search.body?.query || null)
    : null
  const snappedBase = baseQueryRef.current?.nodeId === nodeId ? baseQueryRef.current.query : null
  const exactQuery = useMemo(() => {
    if (!liveEligibleNode) return null
    if (st.level === 0) {
      if (livePageQuery) return livePageQuery
      if (snappedBase) return snappedBase
      if (nodeQuery) return nodeQuery
      if (decodedSlugQuery) return decodedSlugQuery
      if (rowQuery) return rowQuery
    }
    return snappedBase || nodeQuery || decodedSlugQuery
  }, [nodeId, liveEligibleNode, st.level, livePageQuery, snappedBase, nodeQuery, decodedSlugQuery, rowQuery])

  // Snapshot the unrelaxed query after commit (never mutate refs during render).
  useEffect(() => {
    if (st.level === 0 && exactQuery) {
      baseQueryRef.current = { nodeId, query: exactQuery }
    }
  }, [nodeId, st.level, exactQuery])

  const preview = useMemo(() => (exactQuery ? relaxPreview(exactQuery, 1) : null), [exactQuery])

  const run = useCallback(async (targetLevel) => {
    const relaxRpc = window.poe2desktop?.trade?.relax
    if (!relaxRpc) return
    const currentBase = baseQueryRef.current?.nodeId === nodeId ? baseQueryRef.current.query : null
    const sourceQuery = targetLevel === 1 ? (exactQuery || currentBase) : currentBase
    const relaxed = relaxQuery(sourceQuery, targetLevel)
    if (!relaxed) return

    baseQueryRef.current = { nodeId, query: sourceQuery }
    const myReq = ++reqRef.current
    const prevStatus = stRef.current.status
    setSt(prev => ({ ...prev, status: 'checking', authRequired: false, authLevel: null }))

    const r = await relaxRpc({ league, query: relaxed.query }).catch(() => null)
    if (myReq !== reqRef.current) return

    if (!r?.ok) {
      const isAuth = r?.error === 'auth'
      if (r?.error !== 'cancelled') {
        diag('ws', `relax-fail level=${targetLevel} err=${r?.error || 'error'}`)
        toast(relaxErrorLabel(r?.error), false)
      }
      setSt(prev => ({
        ...prev,
        status: prevStatus !== 'checking' ? prevStatus : 'idle',
        authRequired: isAuth,
        authLevel: isAuth ? targetLevel : null,
      }))
      return
    }

    if (!r.total || !Array.isArray(r.rows) || !r.rows.length) {
      diag('ws', `relax-empty level=${targetLevel} req=${relaxed.summary.required}/${relaxed.summary.total}`)
      setSt(prev => ({
        ...prev,
        status: 'empty',
        level: targetLevel,
        summary: relaxed.summary,
        relaxUrl: null,
        authRequired: false,
        authLevel: null,
      }))
      return
    }

    let P = prices
    if (!P || !Object.keys(P).length) {
      P = (await api.stratPrices().catch(() => null))?.prices || null
      if (myReq !== reqRef.current) return
    }

    const best = bestRelaxedCurrency(r.rows, P, options)
    const finalQuery = best.currency ? applyRelaxedCurrency(relaxed.query, best.currency, P) : relaxed.query
    const qStr = JSON.stringify({ query: finalQuery, sort: { price: 'asc' } })
    const url = queryUrl({ q: qStr }, league)

    diag('ws', `relax-apply level=${targetLevel} req=${relaxed.summary.required}/${relaxed.summary.total} total=${r.total} cur=${best.currency || 'default'}`)
    setSt(prev => ({
      status: 'relaxed',
      level: targetLevel,
      summary: relaxed.summary,
      relaxUrl: url,
      relaxedNodeId: nodeId,
      authRequired: false,
      authLevel: null,
      relaxTick: prev.relaxTick + 1,
    }))
  }, [nodeId, exactQuery, league, prices, options])

  const apply = useCallback(() => run(1), [run])
  const further = useCallback(() => run(2), [run])

  const reconnect = useCallback(async () => {
    const targetLevel = stRef.current.authLevel || 1
    const myReq = reqRef.current
    setConnecting(true)
    try {
      const r = await connectSession()
      if (!mountedRef.current || myReq !== reqRef.current) return
      if (r?.ok) {
        await useStatus.getState().refresh()
        if (!mountedRef.current || myReq !== reqRef.current) return
        setSt(prev => ({ ...prev, authRequired: false, authLevel: null }))
        toast('Connected Path of Exile account')
        await run(targetLevel)
      } else {
        toast(r?.message || 'Could not connect Path of Exile account', false)
      }
    } finally {
      if (mountedRef.current) setConnecting(false)
    }
  }, [run])

  const reset = useCallback(() => {
    reqRef.current += 1
    if (stRef.current.relaxUrl) stalePageIdRef.current = pageIdRef.current
    window.poe2desktop?.trade?.relaxCancel?.()
    setSt(prev => ({
      ...IDLE,
      relaxTick: prev.relaxUrl ? prev.relaxTick + 1 : prev.relaxTick,
    }))
  }, [])

  const state = !preview && st.status === 'idle' ? null : st.status

  return {
    state,
    level: st.level,
    active: st.level >= 1 || st.status === 'checking' || !!st.relaxUrl,
    summary: st.summary,
    preview,
    emptyExact: st.level === 0 && !!emptyExact,
    relaxUrl: st.relaxUrl,
    relaxTick: st.relaxTick,
    authRequired: !!st.authRequired,
    connecting,
    apply,
    further,
    reconnect,
    reset,
  }
}
