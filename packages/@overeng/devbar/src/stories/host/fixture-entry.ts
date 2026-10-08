import { startHostDiagnostics } from './boundary.ts'

// This is an ordinary production host unless its build explicitly opts in.
const node = document.createElement('main')
node.textContent = 'Host app'
document.body.append(node)
const controller = new AbortController()
void startHostDiagnostics({
  node,
  enabled: true,
  dark: false,
  storageKey: 'host-build-fixture.panel',
  signal: controller.signal,
}).then((release) => {
  window.addEventListener(
    'pagehide',
    () => {
      controller.abort()
      void release?.()
    },
    { once: true },
  )
})
