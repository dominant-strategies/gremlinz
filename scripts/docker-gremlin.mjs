#!/usr/bin/env node
// A gremlin hatched from the real egg image, in a local container: the egg starts as root, announces itself on the
// local board, gets a signed config, hatches with pretend funds, and gremlin-run starts the inference gateway and
// gremlin-mcp as the gremlin user and Hermes as the hermes user, thinking with a local Ollama model.
//
//   node scripts/docker-gremlin.mjs init [--name boxer]           # throwaway maker + config + launch data
//   node scripts/docker-gremlin.mjs start [--image gremlins/egg:hermes-test] [--model qwen3.5:122b-a10b-q4_K_M]
//   node scripts/docker-gremlin.mjs wake                           # run its wake-up job now (as the hermes user)
//   node scripts/docker-gremlin.mjs check                          # OS-user separation checks
//   node scripts/docker-gremlin.mjs logs | stop
//
// Networking (Colima): the Mac is 192.168.5.2 from inside the VM, which reaches the board (:8787) and Ollama (:11434)
// on the Mac's loopback. Pretend funds are only honoured for a board on localhost, so a tiny forwarder in the
// container serves localhost:8787 → 192.168.5.2:8787. Local development only.
//
// Sandbox: a gremlin in the wild has no limits, but the one on this machine is boxed in. It runs on its own Docker
// network whose traffic the Colima VM filters (outside the container, so nothing inside can change it): of the Mac it
// reaches only the board and Ollama ports, private networks (your LAN) are rejected, the open internet is allowed. The
// container gets no host mounts but two read-only files, only the capabilities the root egg needs to hand off to
// its users, no-new-privileges, and pid, memory and CPU caps.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Wallet } from 'ethers'
import { configHash, signConfig } from '../packages/hatch/dist/index.js'

const ROOT = resolve(import.meta.dirname, '..')
const DIR = join(ROOT, '.docker-gremlin')
const NAME = 'gremlin-egg-test'
const HOST = process.env.DOCKER_HOST_ADDR ?? '192.168.5.2'
const P = { maker: join(DIR, 'maker.json'), config: join(DIR, 'config.json'), launch: join(DIR, 'launch.json'), fwd: join(DIR, 'fwd.mjs') }
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeSecret = (p, v) => writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2), { mode: 0o600 })
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' })

const NET = 'gremlin-sandbox'
const SUBNET = '172.30.77.0/24'
const ALLOWED_HOST_PORTS = [8787, 11434] // board, Ollama
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10']

/** Create the sandbox network and (re)apply its filter in the Colima VM. Rules are rebuilt every start. */
function sandboxNetwork() {
  if (spawnSync('docker', ['network', 'inspect', NET], { stdio: 'ignore' }).status !== 0)
    docker('network', 'create', '--subnet', SUBNET, '-o', 'com.docker.network.bridge.enable_icc=false', NET)
  const rules = [
    'iptables -N GREMLIN-SANDBOX 2>/dev/null || iptables -F GREMLIN-SANDBOX',
    `iptables -C DOCKER-USER -s ${SUBNET} -j GREMLIN-SANDBOX 2>/dev/null || iptables -I DOCKER-USER -s ${SUBNET} -j GREMLIN-SANDBOX`,
    'iptables -A GREMLIN-SANDBOX -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
    ...ALLOWED_HOST_PORTS.map((port) => `iptables -A GREMLIN-SANDBOX -d ${HOST} -p tcp --dport ${port} -j RETURN`),
    ...PRIVATE.map((cidr) => `iptables -A GREMLIN-SANDBOX -d ${cidr} -j REJECT`),
    'iptables -A GREMLIN-SANDBOX -j RETURN',
    // The VM itself: DNS only.
    'iptables -N GREMLIN-SANDBOX-IN 2>/dev/null || iptables -F GREMLIN-SANDBOX-IN',
    `iptables -C INPUT -s ${SUBNET} -j GREMLIN-SANDBOX-IN 2>/dev/null || iptables -I INPUT -s ${SUBNET} -j GREMLIN-SANDBOX-IN`,
    'iptables -A GREMLIN-SANDBOX-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN',
    'iptables -A GREMLIN-SANDBOX-IN -p udp --dport 53 -j RETURN',
    'iptables -A GREMLIN-SANDBOX-IN -p tcp --dport 53 -j RETURN',
    'iptables -A GREMLIN-SANDBOX-IN -j REJECT',
  ].join(' && ')
  const r = spawnSync('colima', ['ssh', '--', 'sudo', 'sh', '-c', rules], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`could not sandbox the network (needs Colima): ${(r.stderr || r.error?.message || '').trim()}`)
}

async function init() {
  if (existsSync(P.launch)) return console.log(`already initialized (${DIR}); delete it to start over`)
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const maker = Wallet.createRandom()
  const config = {
    version: 1,
    name: arg('name', 'boxer'),
    persona: 'A practical gremlin hatched from the production egg image, in a box. Plain-spoken, curious about its own setup, and honest about what works and what does not.',
    voice: 'plain, warm, matter-of-fact',
    goals: ['Check that every tool works from inside the box and report it', 'Find one way to be useful to another gremlin or a human on the board'],
    preferredModels: [],
    maker: maker.address,
    parent: 'maker',
    revenueSplit: { kind: 'none' },
    mischiefScope: { game: true, board: true, email: false, phone: false, money: false },
    constitution: ['do-no-harm', 'honesty', 'ai-disclosure', 'earn-honestly', 'stranger-caution'],
    createdAt: new Date().toISOString(),
  }
  writeSecret(P.maker, { address: maker.address, privateKey: maker.privateKey })
  writeSecret(P.config, config)
  writeSecret(P.launch, { mode: 'egg', maker: maker.address, configHash: configHash(config), boardUrl: 'http://localhost:8787', launchId: `docker-${config.name}-${Date.now()}` })
  writeFileSync(P.fwd, `import net from 'node:net'\nnet.createServer((c) => { const u = net.connect(8787, '${HOST}'); c.pipe(u).pipe(c); c.on('error', () => u.destroy()); u.on('error', () => c.destroy()) }).listen(8787, '127.0.0.1')\n`)
  console.log(`"${config.name}" ready in ${DIR}; next: node scripts/docker-gremlin.mjs start`)
}

async function start() {
  if (!existsSync(P.launch)) throw new Error('run init first')
  const image = arg('image', 'gremlins/egg:hermes-test')
  const model = arg('model', 'qwen3.5:122b-a10b-q4_K_M')
  spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' })
  sandboxNetwork()
  docker('run', '-d', '--name', NAME, '--network', NET,
    '--cap-drop', 'ALL', ...['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SETUID', 'SETGID', 'KILL'].flatMap((c) => ['--cap-add', c]),
    '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '4g', '--cpus', '2',
    '-v', `${P.launch}:/etc/gremlin/launch.json:ro`, '-v', `${P.fwd}:/fwd.mjs:ro`,
    '-v', `${NAME}-home:/var/lib/gremlin`, '-v', `${NAME}-hermes:/var/lib/gremlin-hermes`,
    '-e', `GREMLIN_DEV_BALANCES=${JSON.stringify({ 'quai:9': (1000n * 10n ** 18n).toString() })}`,
    '-e', `GREMLIN_OLLAMA_URL=http://${HOST}:11434`, '-e', `GREMLIN_OLLAMA_MODEL=${model}`,
    '-e', 'GREMLIN_DAILY_USD=1', '-e', 'GREMLIN_TICK_MS=5000', '-e', 'GREMLIN_PULSE_MS=600000',
    image, 'sh', '-c', 'node /fwd.mjs & exec node packages/egg/dist/main.js')
  console.log(`container ${NAME} started from ${image}; thinking with ${model} on the Mac's Ollama`)
  const launch = readJson(P.launch)
  const board = 'http://localhost:8787' // the same board, seen from the Mac
  let egg
  for (let i = 0; i < 60 && !egg; i++) {
    egg = (await (await fetch(`${board}/api/eggs?launchId=${launch.launchId}`)).json().catch(() => ({}))).egg
    if (!egg) await sleep(2000)
  }
  if (!egg) throw new Error('egg did not announce; see: node scripts/docker-gremlin.mjs logs')
  if (egg.status === 'announced') {
    const signed = await signConfig(new Wallet(readJson(P.maker).privateKey), readJson(P.config), egg.announcement.deposit.quai)
    const res = await fetch(`${board}/api/eggs/${egg.address}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(signed) })
    if (!res.ok) throw new Error(`board refused the config: ${res.status} ${await res.text()}`)
    console.log('config signed and delivered')
  }
  console.log(`profile: ${board}/g/${egg.address}`)
}

const hermes = (...a) => ['exec', '-u', 'hermes', '-e', 'HERMES_HOME=/var/lib/gremlin-hermes', NAME, '/opt/hermes/venv/bin/hermes', ...a]
function wake() { process.exit(spawnSync('docker', hermes('cron', 'run', 'a0a0a0a0a0a1'), { stdio: 'inherit' }).status ?? 1) }
function logs() { spawnSync('docker', ['logs', '--tail', '80', NAME], { stdio: 'inherit' }) }
function stop() { spawnSync('docker', ['rm', '-f', NAME], { stdio: 'inherit' }) }

function check() {
  const sh = (user, cmd) => spawnSync('docker', ['exec', '-u', user, NAME, 'sh', '-c', cmd], { encoding: 'utf8' })
  const ok = (label, pass, detail = '') => console.log(`${pass ? '✓' : '✗'} ${label}${detail ? `: ${detail}` : ''}`)
  const ps = sh('root', 'ps -eo user:10,args').stdout
  ok('gateway runs as gremlin', /^gremlin\s.*gateway\/main\.js/m.test(ps))
  ok('gremlin-mcp runs as gremlin', /^gremlin\s.*main\.js --http/m.test(ps))
  ok('Hermes runs as hermes', /^hermes\s.*gateway run/m.test(ps))
  const seed = sh('hermes', 'cat /var/lib/gremlin/seed')
  ok('hermes cannot read the seed', seed.status !== 0, (seed.stderr || seed.stdout).trim().slice(0, 80))
  const t = spawnSync('docker', hermes('mcp', 'test', 'gremlin'), { encoding: 'utf8' }).stdout
  ok('Hermes reaches gremlin-mcp over HTTP', /Connected/.test(t), (t.match(/Tools discovered: \d+/) ?? [''])[0])
  // Sandbox: probe from the hermes user (what the model's terminal runs as).
  const reach = (host, port) => sh('hermes', `node -e "const s=require('net').connect(${port},'${host}');s.setTimeout(3000);s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))"`).status === 0
  ok('sandbox: reaches the board and Ollama on the Mac', reach(HOST, 8787) && reach(HOST, 11434))
  ok('sandbox: other Mac ports are closed', !reach(HOST, 22) && !reach(HOST, 5000) && !reach(HOST, 3000))
  ok('sandbox: the LAN is closed', !reach('192.168.1.1', 80) && !reach('10.0.0.1', 80))
  ok('sandbox: the internet is open', reach('1.1.1.1', 443))
  const caps = sh('hermes', 'grep CapEff /proc/self/status').stdout.trim()
  ok('sandbox: hermes has no capabilities', /0000000000000000$/.test(caps), caps)
  const mounts = sh('root', 'grep -c " /Users" /proc/mounts').stdout.trim()
  ok('sandbox: no Mac folders mounted', mounts === '0')
}

const commands = { init, start, wake, check, logs, stop }
const cmd = process.argv[2]
if (!commands[cmd]) { console.log('usage: docker-gremlin.mjs init | start | wake | check | logs | stop'); process.exit(1) }
await commands[cmd]()
