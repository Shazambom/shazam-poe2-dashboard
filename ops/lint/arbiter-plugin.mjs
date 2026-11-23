// The in-repo `arbiter` ESLint plugin: AST rules for the contracts in CLAUDE.md that no published
// plugin knows. Which file owns what is a rule option set in ops/lint/eslint.config.mjs, never a path
// written here. Each message tells the reader what to change. Tests: ops/lint/arbiter-plugin.test.mjs.
import path from 'node:path'

const ASK = ' If the rule is wrong for this code, stop and ask the owner.'
const say = (messages) => Object.fromEntries(Object.entries(messages).map(([id, text]) => [id, text + ASK]))

/** The linted file relative to ESLint's cwd (the repo root), with forward slashes. */
const relPath = (context) => path.relative(context.cwd, context.filename).split(path.sep).join('/')

const isFunction = (node) => node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'

/** A string the code spells out in full: a string literal or a template with no expressions. */
const staticString = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
  return null
}

/** The name a member expression reads (`a.b`, `a['b']`), or null when it is computed at runtime. */
const memberName = (node) => {
  if (node?.type !== 'MemberExpression') return null
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  return staticString(node.property)
}

const isRequireCall = (node) => node?.type === 'CallExpression' && node.callee.type === 'Identifier'
  && node.callee.name === 'require'

const requiredName = (node) => (isRequireCall(node) ? staticString(node.arguments[0]) : null)

/** Every text a literal carries: string, regex pattern, or a template's fixed parts. */
const literalText = (node) => {
  if (node.type === 'Literal') {
    if (node.regex) return node.regex.pattern
    return typeof node.value === 'string' ? node.value : null
  }
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('')
  return null
}

/** The variable an identifier resolves to, or null when it is an undeclared global. */
const resolve = (context, id) => {
  for (let scope = context.sourceCode.getScope(id); scope; scope = scope.upper) {
    const variable = scope.set.get(id.name)
    if (variable) return variable
  }
  return null
}

/** True when the identifier is the runtime global of that name (not a local, parameter or import). */
const isGlobal = (context, id) => {
  const variable = resolve(context, id)
  return !variable || variable.defs.length === 0
}

const pathList = { type: 'array', items: { type: 'string' }, uniqueItems: true }

// ---------------------------------------------------------------------------------------------

const catchMustHandle = {
  meta: {
    type: 'problem',
    docs: { description: 'A catch block or rejection handler must contain a statement; a comment is not handling.' },
    schema: [],
    messages: say({
      emptyCatch: 'This catch block swallows the error: it has no statement, and a comment is not handling. '
        + 'Handle it: log it through the module\'s non-throwing logger, rethrow it, or return a fallback the caller checks.',
      emptyPromiseCatch: 'This rejection handler swallows the error: its body is empty, and a comment is not handling. '
        + 'Handle it: log it through the module\'s non-throwing logger, or let the rejection reach a caller that handles it.',
    }),
  },
  create(context) {
    const emptyBody = (fn) => isFunction(fn) && fn.body.type === 'BlockStatement' && fn.body.body.length === 0
    return {
      CatchClause(node) {
        if (node.body.body.length === 0) context.report({ node, messageId: 'emptyCatch' })
      },
      CallExpression(node) {
        const name = memberName(node.callee)
        let handler = null
        if (name === 'catch') handler = node.arguments[0]
        else if (name === 'then') handler = node.arguments[1]
        if (emptyBody(handler)) context.report({ node: handler, messageId: 'emptyPromiseCatch' })
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------

// Network module names → the kind of primitive they give.
const NETWORK_MODULES = {
  http: 'http', https: 'https', http2: 'http2', net: 'node:net', tls: 'tls', dgram: 'dgram', undici: 'undici', ws: 'ws',
}
// Browser-style globals → kind.
const NETWORK_GLOBALS = { fetch: 'fetch', WebSocket: 'ws', XMLHttpRequest: 'XMLHttpRequest', EventSource: 'EventSource' }
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global'])
const KIND_KEY = { 'electron net': 'net' }

const networkPrimitivesAllowlist = {
  meta: {
    type: 'problem',
    docs: { description: 'Each network primitive is used only by the module that owns it.' },
    schema: [{
      type: 'object',
      properties: { owners: { type: 'object', additionalProperties: pathList } },
      additionalProperties: false,
    }],
    defaultOptions: [{ owners: {} }],
    messages: say({
      primitive: '`{{what}}` is a network primitive, and only {{owners}} may use it. Route this call through that '
        + 'module (loopback /api calls through the local-backend helper, telemetry through telemetry.installLog, '
        + 'pathofexile.com through the trade proxy); do not add a new path to the network.',
    }),
  },
  create(context) {
    const [{ owners }] = context.options
    const file = relPath(context)
    const report = (node, what) => {
      const allowed = owners[KIND_KEY[what] ?? what] ?? []
      if (allowed.includes(file)) return
      context.report({ node, messageId: 'primitive', data: { what, owners: allowed.join(', ') || 'no module' } })
    }
    const moduleKind = (name) => (name == null ? null : NETWORK_MODULES[name.replace(/^node:/, '')] ?? null)
    const isElectron = (node) => requiredName(node) === 'electron'
    const boundToElectron = (id) => {
      const def = resolve(context, id)?.defs[0]
      return def?.node.type === 'VariableDeclarator' && def.node.id.type === 'Identifier' && isElectron(def.node.init)
    }
    // `globalThis.fetch = shim` replaces the primitive; it is not a use of it.
    const isAssignedTo = (node) => node.parent.type === 'AssignmentExpression' && node.parent.left === node
    const sessionLike = (node) => (node.type === 'Identifier' && (node.name === 'session' || node.name === 'defaultSession'))
      || ['session', 'defaultSession'].includes(memberName(node))
    return {
      'Program:exit'() {
        const globalScope = context.sourceCode.scopeManager.globalScope
        const refs = [...globalScope.through]
        for (const name of Object.keys(NETWORK_GLOBALS)) {
          const variable = globalScope.set.get(name)
          if (variable && variable.defs.length === 0) refs.push(...variable.references)
        }
        for (const ref of refs) {
          const what = NETWORK_GLOBALS[ref.identifier.name]
          if (what && !isAssignedTo(ref.identifier)) report(ref.identifier, what)
        }
      },
      MemberExpression(node) {
        const name = memberName(node)
        if (name in NETWORK_GLOBALS && node.object.type === 'Identifier' && GLOBAL_OBJECTS.has(node.object.name)
          && isGlobal(context, node.object) && !isAssignedTo(node)) report(node, NETWORK_GLOBALS[name])
        if (name === 'net' && (isElectron(node.object) || (node.object.type === 'Identifier' && boundToElectron(node.object)))) {
          report(node, 'electron net')
        }
      },
      CallExpression(node) {
        const kind = moduleKind(requiredName(node))
        if (kind) report(node, kind)
        if (memberName(node.callee) === 'fetch' && sessionLike(node.callee.object)) report(node, 'electron net')
      },
      ImportExpression(node) {
        const kind = moduleKind(staticString(node.source))
        if (kind) report(node, kind)
      },
      ImportDeclaration(node) {
        const kind = moduleKind(node.source.value)
        if (kind) report(node, kind)
        if (node.source.value === 'electron') {
          for (const s of node.specifiers) {
            if (s.type === 'ImportSpecifier' && (s.imported.name ?? s.imported.value) === 'net') report(s, 'electron net')
          }
        }
      },
      Property(node) {
        const pattern = node.parent
        if (pattern.type !== 'ObjectPattern' || pattern.parent.type !== 'VariableDeclarator') return
        const key = node.computed ? staticString(node.key) : node.key.name ?? node.key.value
        if (key === 'net' && isElectron(pattern.parent.init)) report(node, 'electron net')
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------

const TELEMETRY_URL = /\/api\/installlog\b|\/\/(?:shazam\b|192\.168\.|10\.\d{1,3}\.|172\.(?:1[6-9]|2\d|3[01])\.)/i

const telemetrySingleSender = {
  meta: {
    type: 'problem',
    docs: { description: 'One telemetry sender and one telemetry URL constant, both in the owner module.' },
    schema: [{
      type: 'object',
      properties: { owner: { type: 'string' }, allowRead: pathList },
      required: ['owner'],
      additionalProperties: false,
    }],
    messages: say({
      read: '`{{name}}` is the telemetry URL constant, and only {{owner}} may read it. Send diagnostics through '
        + 'installLog() from {{owner}}, which applies the beta/dev gate.',
      url: 'This literal names the telemetry server. Only {{owner}} may hold that URL: call installLog() from it instead.',
      sender: 'This defines a second `installLog` sender. Every diagnostic goes through the one installLog() in {{owner}}: '
        + 'import it and delete this definition.',
    }),
  },
  create(context) {
    const [{ owner, allowRead = [] }] = context.options
    if (relPath(context) === owner) return {}
    const data = { owner }
    const checkText = (node) => {
      const text = literalText(node)
      if (text && TELEMETRY_URL.test(text)) context.report({ node, messageId: 'url', data })
    }
    const sender = (node) => context.report({ node, messageId: 'sender', data })
    return {
      Literal: checkText,
      TemplateLiteral: checkText,
      MemberExpression(node) {
        const name = memberName(node)
        if (name === 'SHAZAM' && !allowRead.includes(name)) context.report({ node, messageId: 'read', data: { ...data, name } })
      },
      Property(node) {
        const key = node.computed ? staticString(node.key) : node.key.name ?? node.key.value
        if (node.parent.type === 'ObjectPattern' && key === 'SHAZAM' && !allowRead.includes(key)) {
          context.report({ node, messageId: 'read', data: { ...data, name: key } })
        }
        if (node.parent.type === 'ObjectExpression' && key === 'installLog' && isFunction(node.value)) sender(node)
      },
      FunctionDeclaration(node) {
        if (node.id?.name === 'installLog') sender(node)
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.id.name === 'installLog' && isFunction(node.init)) sender(node)
      },
      MethodDefinition(node) {
        if (node.key.name === 'installLog') sender(node)
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------

const SPAWNERS = new Set(['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync'])

const noEnvConfig = {
  meta: {
    type: 'problem',
    docs: { description: 'No environment variable configures product behaviour.' },
    schema: [{ type: 'object', properties: { allow: pathList }, additionalProperties: false }],
    defaultOptions: [{ allow: [] }],
    messages: say({
      read: '`process.env.{{name}}` makes the environment a configuration surface, which CLAUDE.md bans. Use a code '
        + 'constant or a user setting instead; process plumbing for a child goes in its spawn options object.',
      dynamic: 'This uses process.env as a whole or by a computed key, so the variables it depends on cannot be checked. '
        + 'Read named OS path variables only, and pass the environment to a child only as `env: { ...process.env, … }` '
        + 'inside a spawn/fork options object.',
    }),
  },
  create(context) {
    const [{ allow }] = context.options
    const isProcessEnv = (node) => node.type === 'MemberExpression' && node.object.type === 'Identifier'
      && node.object.name === 'process' && memberName(node) === 'env'
    // `env: <node>` as a property of an options object passed straight to a spawn-family call.
    const inSpawnOptions = (property) => {
      if (property?.type !== 'Property') return false
      const key = property.computed ? staticString(property.key) : property.key.name ?? property.key.value
      const options = property.parent
      const call = options.parent
      return key === 'env' && options.type === 'ObjectExpression' && call?.type === 'CallExpression'
        && call.arguments.includes(options)
        && SPAWNERS.has(call.callee.type === 'Identifier' ? call.callee.name : memberName(call.callee))
    }
    const read = (node, name) => {
      if (!allow.includes(name)) context.report({ node, messageId: 'read', data: { name } })
    }
    return {
      MemberExpression(node) {
        if (!isProcessEnv(node)) return
        const parent = node.parent
        if (parent.type === 'MemberExpression' && parent.object === node) {
          const name = memberName(parent)
          if (name == null) context.report({ node: parent, messageId: 'dynamic' })
          else read(parent, name)
          return
        }
        if (parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'ObjectPattern') {
          for (const p of parent.id.properties) {
            const name = p.type === 'Property' ? (p.computed ? staticString(p.key) : p.key.name ?? p.key.value) : null
            if (name == null) context.report({ node: p, messageId: 'dynamic' })
            else read(p, name)
          }
          return
        }
        if (parent.type === 'SpreadElement' && inSpawnOptions(parent.parent.parent)) return
        if (parent.type === 'Property' && parent.value === node && inSpawnOptions(parent)) return
        context.report({ node, messageId: 'dynamic' })
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------

const preloadRequireElectronOnly = {
  meta: {
    type: 'problem',
    docs: { description: 'A sandboxed preload loads only electron.' },
    schema: [],
    messages: say({
      require: 'The sandboxed preload may load only `require(\'electron\')`; this loads {{name}}. Move that logic into '
        + 'the main process behind an IPC channel, or into the renderer.',
    }),
  },
  create(context) {
    const report = (node, name) => context.report({ node, messageId: 'require', data: { name } })
    return {
      CallExpression(node) {
        if (!isRequireCall(node)) return
        const name = staticString(node.arguments[0])
        if (name !== 'electron') report(node, name ?? '(computed)')
      },
      ImportExpression(node) {
        report(node, `import(${staticString(node.source) ?? '(computed)'})`)
      },
      ImportDeclaration(node) {
        report(node, `import ${node.source.value}`)
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------

const IPC_METHODS = new Set(['invoke', 'send', 'sendSync', 'sendToHost', 'postMessage', 'on', 'once', 'off',
  'addListener', 'removeListener', 'removeAllListeners'])

const noRawIpcRendererExpose = {
  meta: {
    type: 'problem',
    docs: { description: 'ipcRenderer never crosses the bridge, and every channel is a literal.' },
    schema: [],
    messages: say({
      expose: 'ipcRenderer (or one of its methods) is handed out as a value, which gives the page every IPC channel. '
        + 'Expose one function per channel that calls ipcRenderer with a literal channel name.',
      channel: 'The IPC channel here is not a string literal, so the page could choose the channel. Pass the channel '
        + 'name as a literal, or through a helper whose every call site in this file passes a literal.',
    }),
  },
  create(context) {
    const isIpc = (node) => node?.type === 'Identifier' && node.name === 'ipcRenderer'
    // `ch` is a direct parameter of a named function whose every call in this file passes a literal there.
    const literalAtEveryCallSite = (id) => {
      const def = resolve(context, id)?.defs[0]
      if (def?.type !== 'Parameter') return false
      const fn = def.node
      const index = fn.params.indexOf(def.name)
      if (index < 0) return false
      let named = null
      if (fn.type === 'FunctionDeclaration') named = fn
      else if (fn.parent.type === 'VariableDeclarator' && fn.parent.init === fn && fn.parent.id.type === 'Identifier') named = fn.parent
      if (!named) return false
      const variable = context.sourceCode.getDeclaredVariables(named).find((v) => v.defs.some((d) => d.node === named))
      const reads = variable.references.filter((r) => r.isRead())
      return reads.every((r) => {
        const call = r.identifier.parent
        return call.type === 'CallExpression' && call.callee === r.identifier && staticString(call.arguments[index]) != null
      })
    }
    const channelOk = (arg) => staticString(arg) != null || (arg?.type === 'Identifier' && literalAtEveryCallSite(arg))
    return {
      CallExpression(node) {
        if (!isIpc(node.callee.object) || !IPC_METHODS.has(memberName(node.callee))) return
        if (!channelOk(node.arguments[0])) context.report({ node, messageId: 'channel' })
      },
      Identifier(node) {
        if (!isIpc(node)) return
        const parent = node.parent
        if (parent.type === 'Property' && parent.parent.type === 'ObjectPattern') return
        const asValue = (parent.type === 'Property' && parent.value === node)
          || parent.type === 'ArrayExpression' || parent.type === 'SpreadElement'
          || (parent.type === 'CallExpression' && parent.arguments.includes(node))
          || parent.type === 'ReturnStatement'
          || (parent.type === 'ArrowFunctionExpression' && parent.body === node)
          || (parent.type === 'AssignmentExpression' && parent.right === node)
          || (parent.type === 'VariableDeclarator' && parent.init === node)
        if (asValue) context.report({ node, messageId: 'expose' })
      },
      MemberExpression(node) {
        // `ipcRenderer.invoke` taken as a value rather than called (`.bind(...)` on it is caught by its argument).
        if (!isIpc(node.object) || !IPC_METHODS.has(memberName(node))) return
        const parent = node.parent
        if (parent.type === 'CallExpression' && parent.callee === node) return
        if (parent.type === 'MemberExpression' && parent.object === node) return
        context.report({ node, messageId: 'expose' })
      },
    }
  },
}

// ---------------------------------------------------------------------------------------------

const rateLimitHeadersBackendOnly = {
  meta: {
    type: 'problem',
    docs: { description: 'X-Rate-Limit headers are forwarded to the backend, never parsed in JavaScript.' },
    schema: [{ type: 'object', properties: { owners: pathList }, required: ['owners'], additionalProperties: false }],
    messages: say({
      parse: 'This reads X-Rate-Limit headers outside the forwarders ({{owners}}). The bundled backend owns the '
        + 'pathofexile.com rate budget: forward the raw headers through budget.observe() and act on its answer.',
    }),
  },
  create(context) {
    const [{ owners }] = context.options
    if (owners.includes(relPath(context))) return {}
    const check = (node) => {
      const text = literalText(node)
      if (text && /x-rate-limit/i.test(text)) context.report({ node, messageId: 'parse', data: { owners: owners.join(', ') } })
    }
    return { Literal: check, TemplateLiteral: check }
  },
}

// ---------------------------------------------------------------------------------------------

const WINDOW_CLASSES = new Set(['BrowserWindow', 'BrowserView', 'WebContentsView'])
// flag → the only literal value that is safe; any other value (or a non-literal) is reported.
const SAFE_VALUE = {
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  sandbox: true,
  contextIsolation: true,
}
const MUST_STATE = ['sandbox', 'contextIsolation']

const secureWebPreferences = {
  meta: {
    type: 'problem',
    docs: { description: 'webPreferences never weaken Electron isolation, and each window states it.' },
    schema: [],
    messages: say({
      insecure: '`{{flag}}` here weakens Electron isolation. Set `{{flag}}: {{safe}}` (or delete the key when that is '
        + 'the default) and do the work in the main process behind an IPC channel.',
      blink: '`enableBlinkFeatures` turns on unreviewed Chromium features. Delete it.',
      mustState: 'This {{kind}} does not state {{missing}} in an inline webPreferences object. Write them out. Before '
        + 'changing a window that runs today, read its getLastWebPreferences(): if the value differs from what you '
        + 'would write, the change alters behaviour and goes to the owner.',
    }),
  },
  create(context) {
    const keyOf = (p) => (p.type === 'Property' ? (p.computed ? staticString(p.key) : p.key.name ?? p.key.value) : null)
    const webPreferences = (options) => (options?.type === 'ObjectExpression'
      ? options.properties.find((p) => keyOf(p) === 'webPreferences') : undefined)
    return {
      Property(node) {
        if (keyOf(node) !== 'webPreferences' || node.value.type !== 'ObjectExpression') return
        for (const p of node.value.properties) {
          const flag = keyOf(p)
          if (flag === 'enableBlinkFeatures') context.report({ node: p, messageId: 'blink' })
          else if (flag in SAFE_VALUE && !(p.value.type === 'Literal' && p.value.value === SAFE_VALUE[flag])) {
            context.report({ node: p, messageId: 'insecure', data: { flag, safe: String(SAFE_VALUE[flag]) } })
          }
        }
      },
      NewExpression(node) {
        const kind = node.callee.type === 'Identifier' ? node.callee.name : memberName(node.callee)
        if (!WINDOW_CLASSES.has(kind)) return
        const prefs = webPreferences(node.arguments[0])
        const stated = new Set(prefs?.value.type === 'ObjectExpression'
          ? prefs.value.properties.filter((p) => p.value?.type === 'Literal' && p.value.value === true).map(keyOf)
          : [])
        const missing = MUST_STATE.filter((k) => !stated.has(k)).map((k) => `${k}: true`)
        if (missing.length) context.report({ node, messageId: 'mustState', data: { kind, missing: missing.join(', ') } })
      },
    }
  },
}

export default {
  meta: { name: 'arbiter' },
  rules: {
    'catch-must-handle': catchMustHandle,
    'network-primitives-allowlist': networkPrimitivesAllowlist,
    'telemetry-single-sender': telemetrySingleSender,
    'no-env-config': noEnvConfig,
    'preload-require-electron-only': preloadRequireElectronOnly,
    'no-raw-ipcrenderer-expose': noRawIpcRendererExpose,
    'rate-limit-headers-backend-only': rateLimitHeadersBackendOnly,
    'secure-web-preferences': secureWebPreferences,
  },
}
