import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'

// Diagnose the runner's proc visibility without printing argv, environment or paths.
const attempt = (read) => {
  try { return { value: read() } } catch (error) { return { error: error.code } }
}
const namespaces = (pid) => Object.fromEntries(['pid', 'user', 'mnt'].map((name) => [name, attempt(() => readlinkSync(`/proc/${pid}/ns/${name}`))]))
console.log('GC_PROC_DIAGNOSTIC_SELF', JSON.stringify({ pid: process.pid, uid: process.getuid(), namespaces: namespaces('self'), mountOptions: readFileSync('/proc/mounts', 'utf8').split('\n').filter((line) => line.split(' ')[1] === '/proc').map((line) => line.split(' ')[3]) }))
for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
  const status = attempt(() => readFileSync(`/proc/${pid}/status`, 'utf8'))
  if (status.value === undefined) continue
  const fields = Object.fromEntries(status.value.split('\n').map((line) => line.split(/:\s*/, 2)))
  if (fields.Uid?.split(/\s+/).includes(String(process.getuid())) !== true) continue
  const probes = Object.fromEntries(['cwd', 'root', 'exe'].map((name) => [name, attempt(() => { readlinkSync(`/proc/${pid}/${name}`); return 'readable' })]))
  probes.fd = attempt(() => { for (const fd of readdirSync(`/proc/${pid}/fd`)) readlinkSync(`/proc/${pid}/fd/${fd}`); return 'readable' })
  probes.maps = attempt(() => { readFileSync(`/proc/${pid}/maps`); return 'readable' })
  if (Object.values(probes).some((probe) => probe.error === 'EACCES' || probe.error === 'EPERM') === false) continue
  const parent = fields.PPid
  const parentStatus = attempt(() => readFileSync(`/proc/${parent}/status`, 'utf8').split('\n').filter((line) => /^(Name|Uid|PPid|NSpid):/.test(line)))
  console.log('GC_PROC_DIAGNOSTIC_UNREADABLE', JSON.stringify({ pid, fields: Object.fromEntries(['Name', 'PPid', 'Uid', 'Gid', 'NSpid', 'CapEff', 'NoNewPrivs', 'Seccomp'].map((key) => [key, fields[key]])), procOwner: attempt(() => statSync(`/proc/${pid}`).uid), probes, namespaces: namespaces(pid), parentStatus }))
}
