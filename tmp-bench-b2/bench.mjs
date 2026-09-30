import { candidates, fields, support } from './codecs.mjs'
import { hostname, loadavg, cpus } from 'node:os'
import { writeFileSync } from 'node:fs'
const safe = process.argv.includes('--safe')
const rounds = Number(process.env.ROUNDS ?? 12)
const values = safe ? [0n,1n,123456789n,9007199254740990n,9007199254740991n] : [0n,9007199254740991n,9007199254740993n,9223372036854775807n,18446744073709551615n]
const makeRows = count => Array.from({length:count}, (_,i) => Object.fromEntries(fields.map((key,j)=>[key,values[(i+j)%values.length]])))
const oneRowBytes = candidates.a.encode(makeRows(1000)).length / 1000
const configs = [{name:'1k',count:1000},{name:'1MB',count:Math.floor(1e6/oneRowBytes)},{name:'10MB',count:Math.floor(1e7/oneRowBytes)}]
const measurements = []
const features = support()
for (const config of configs) {
  const rows = makeRows(config.count)
  const baselineBytes = candidates.a.encode(rows).length
  const available = Object.entries(candidates).filter(([key]) => (key !== 'b' || features.source && features.rawJSON) && (key !== 'e' || safe))
  const encoded = Object.fromEntries(available.map(([key,codec])=>[key,codec.encode(rows)]))
  for (const [,codec] of available) {for (let i=0;i<3;i++) {codec.decode(codec.encode(rows))}}
  for (let round = 0; round < rounds; round++) {
    // Rotating and reversing candidate order balances first/last and A/B temporal bias.
    let order = available.slice(round % available.length).concat(available.slice(0,round % available.length))
    if (round % 2) order.reverse()
    for (const [key,codec] of order) for (const operation of round % 2 ? ['encode','decode'] : ['decode','encode']) {
      const before = {date:new Date().toISOString(),load:loadavg()}
      const repetitions = config.name === '1k' ? 20 : config.name === '1MB' ? 3 : 1
      let result
      const start = performance.now()
      for (let i=0;i<repetitions;i++) result = operation === 'decode' ? codec.decode(encoded[key]) : codec.encode(rows)
      const ms = (performance.now()-start)/repetitions
      if (!result || result.length === 0) throw new Error('benchmark result')
      measurements.push({config:config.name,count:config.count,candidate:key,operation,round,ms,semanticMBps:baselineBytes/ms/1000,wireBytes:encoded[key].length,wireMBps:encoded[key].length/ms/1000,...before})
    }
  }
}
const mean = values => values.reduce((a,b)=>a+b,0)/values.length
const summary = []
for (const config of configs) for (const candidate of Object.keys(candidates)) for (const operation of ['decode','encode']) {
  const rows = measurements.filter(row=>row.config===config.name && row.candidate===candidate && row.operation===operation)
  if (!rows.length) continue
  const samples = rows.map(row=>row.semanticMBps), avg = mean(samples)
  summary.push({config:config.name,candidate,operation,meanMBps:avg,sdMBps:Math.sqrt(samples.reduce((a,b)=>a+(b-avg)**2,0)/(samples.length-1)),wireBytes:rows[0].wireBytes,count:rows[0].count,loadRange:[Math.min(...rows.map(row=>row.load[0])),Math.max(...rows.map(row=>row.load[0]))]})
}
const output = {host:hostname(),cpus:cpus().length,cpuModel:cpus()[0].model,runtime:process.versions,date:new Date().toISOString(),safe,rounds,features,summary,measurements}
writeFileSync(process.env.OUTPUT ?? `evidence/bench-${process.versions.bun?'bun':'node'}${safe?'-safe':''}.json`,JSON.stringify(output,null,2))
console.log(JSON.stringify({host:output.host,date:output.date,summary},null,2))
