// Runs in a plugin window: rebuilds the `ctx` API (resources/plugins/claudeterm.d.ts) over the host bridge, provides
// CommonJS require for the plugin's own files, then calls activate(ctx). Evaluated as
// `(function (bridge, manifest, files) { … })(window.ctPlugin, manifest, files)`; also run under Node by the tests.
(function (bridge, manifest, files) {
  const unwrap = (r) => { if (r && r.error) throw new Error(r.error); return r ? r.value : undefined }
  const call = (m, a) => unwrap(bridge.call(m, a))
  const callAsync = (m, a) => Promise.resolve(bridge.callAsync(m, a)).then(unwrap)
  const send = (m, a) => bridge.send(m, a)

  const listeners = new Map()
  const on = (ev, cb) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(cb); return () => listeners.get(ev).delete(cb) }
  bridge.onEvent((ev, args) => (listeners.get(ev) || []).forEach((cb) => { try { cb(...(args || [])) } catch (e) { console.error(`[${ev}]`, e) } }))

  const watchers = new Map()
  on('fs', (wid, name) => { const cb = watchers.get(wid); if (cb) cb(name) })

  // console: kept in the window (devtools) and forwarded to the app's log
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console)
    console[level] = (...a) => { orig(...a); try { send('console', [level, a.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : safeJson(x)))]) } catch (e) { /* bridge gone */ } }
  }
  function safeJson(x) { try { return JSON.stringify(x) } catch (e) { return String(x) } }

  const view = (localId) => {
    const viewId = manifest.id + ':' + localId
    return { set: (model) => call('ui.viewSet', { viewId, model }), onEvent: (cb) => on('view:' + viewId, cb) }
  }
  const ctx = {
    plugin: { id: manifest.id, dir: call('plugin.dir') },
    workspace: {
      get project() { return call('workspace.project') },
      onDidChangeProject: (cb) => on('project', cb),
      projects: () => call('workspace.projects'),
      onDidChangeProjects: (cb) => on('projects', cb),
      get visible() { return call('workspace.visible') },
      onDidChangeVisibility: (cb) => on('visibility', cb),
      openProject: (path, opts) => call('workspace.openProject', { path, claude: !!(opts && opts.claude) }),
      openUrl: (url) => call('workspace.openUrl', { url }),
      openFile: (path) => call('workspace.openFile', { path }),
      openDiff: (req) => call('workspace.openDiff', req),
      selection: () => callAsync('workspace.selection'),
      fs: {
        exists: (path) => call('fs.exists', { path }),
        read: (path) => call('fs.read', { path }),
        list: (path) => call('fs.list', { path }),
        watch: (path, cb) => {
          let wid
          try { wid = call('fs.watch', { path }) } catch (e) { return () => {} }
          watchers.set(wid, cb)
          return () => { watchers.delete(wid); try { call('fs.unwatch', { wid }) } catch (e) { /* gone */ } }
        },
      },
    },
    ui: {
      view,
      notify: (title, body) => call('ui.notify', { title, body }),
      projectDecoration: (root, deco) => call('ui.projectDecoration', { root, deco: deco || null }),
      popover: (localViewId, model) => {
        const id = call('ui.popover', { viewId: manifest.id + ':' + localViewId, model })
        return {
          id,
          update: (m) => call('ui.popoverUpdate', { id, viewId: manifest.id + ':' + localViewId, model: m }),
          close: () => call('ui.popoverClose', { id }),
          onEvent: (cb) => on('view:' + id, cb),
        }
      },
      prompt: (req) => callAsync('ui.prompt', req),
    },
    terminal: {
      run: (req) => call('terminal.run', req),
      onCommandEnd: (cb) => on('commandEnd', cb),
      runs: () => call('terminal.runs'),
      onDidChangeRuns: (cb) => on('runs', cb),
      stop: (id) => call('terminal.stop', { id }),
      show: (id) => call('terminal.show', { id }),
    },
    process: {
      exec: (file, args, opts) => callAsync('process.exec', { file, args: args || [], cwd: opts && opts.cwd, timeout: opts && opts.timeout }),
    },
    claude: {
      insertPrompt: (text, opts) => call('claude.insertPrompt', { text, send: !!(opts && opts.send) }),
    },
    commands: {
      set: (list) => call('commands.set', { list }),
      onRun: (cb) => on('command', cb),
    },
    settings: { get: (key) => call('settings.get', { key }) },
    storage: { get: (key) => call('storage.get', { key }), set: (key, value) => call('storage.set', { key, value }) },
  }

  // CommonJS for the plugin's own files (files: posix relative path → source)
  const cache = {}
  const norm = (p) => { const out = []; for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') { if (!out.length) throw new Error('require outside the plugin folder'); out.pop() } else out.push(s) } return out.join('/') }
  const requireFrom = (from) => (name) => {
    const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
    const has = (k) => Object.prototype.hasOwnProperty.call(files, k)
    let key = norm((name.startsWith('.') ? base : '') + name)
    if (!has(key) && has(key + '.js')) key += '.js'
    if (!has(key)) throw new Error(`module not found in the plugin: ${name}`)
    if (cache[key]) return cache[key].exports
    const mod = { exports: {} }
    cache[key] = mod
    new Function('module', 'exports', 'require', files[key] + `\n//# sourceURL=plugin://${manifest.id}/${key}`)(mod, mod.exports, requireFrom(key))
    return mod.exports
  }

  const fail = (e) => send('fail', String((e && (e.stack || e.message)) || e))
  try {
    const main = requireFrom('')(manifest.main.replace(/^\.\//, ''))
    const activate = main.activate || (main.default && main.default.activate)
    if (typeof activate !== 'function') throw new Error('main.js exports no activate(ctx)')
    const deactivate = main.deactivate || (main.default && main.default.deactivate)
    if (typeof deactivate === 'function') on('deactivate', () => deactivate())
    Promise.resolve(activate(ctx)).catch(fail)
  } catch (e) { fail(e) }
  return ctx
})
