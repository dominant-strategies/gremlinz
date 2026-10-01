/**
 * Conway Cloud client (subset) and nest bootstrap. Sandboxes are Linux VMs paid from the gremlin's own Conway
 * credits (prepaid, non-refundable), owned by the gremlin's wallet via its SIWE-provisioned API key.
 * Browser-safe: fetch only. Note Conway's API is not callable from arbitrary browser origins (CORS allowlist),
 * so this runs server-side, from the gremlin.
 */

export const CONWAY_API = 'https://api.conway.tech'

/** Valid sandbox sizes (from the Conway runtime's replication code). */
export const SANDBOX_TIERS = [
  { memoryMb: 512, vcpu: 1, diskGb: 5 },
  { memoryMb: 1024, vcpu: 1, diskGb: 10 },
  { memoryMb: 2048, vcpu: 2, diskGb: 20 },
  { memoryMb: 4096, vcpu: 2, diskGb: 40 },
  { memoryMb: 8192, vcpu: 4, diskGb: 80 },
] as const

export interface PricingTier {
  name: string
  vcpu: number
  memoryMb: number
  diskGb: number
  monthlyCents: number
}

export function conway(opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
  const base = opts.baseUrl ?? CONWAY_API
  const f = opts.fetchImpl ?? fetch
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await f(base + path, {
      method,
      // Conway expects the raw key, not "Bearer …"
      headers: { 'content-type': 'application/json', authorization: opts.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Conway ${method} ${path} ${res.status}: ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : undefined) as T
  }
  return {
    creditsCents: async () => {
      const r = await call<{ balance_cents?: number; credits_cents?: number }>('GET', '/v1/credits/balance')
      return r.balance_cents ?? r.credits_cents ?? 0
    },
    pricing: async (): Promise<PricingTier[]> => {
      const r = await call<{ tiers?: any[]; pricing?: any[] }>('GET', '/v1/credits/pricing')
      return (r.tiers ?? r.pricing ?? []).map((t) => ({ name: t.name ?? '', vcpu: t.vcpu ?? 0, memoryMb: t.memory_mb ?? 0, diskGb: t.disk_gb ?? 0, monthlyCents: t.monthly_cents ?? 0 }))
    },
    createSandbox: async (o: { name: string; memoryMb: number; vcpu: number; diskGb: number; region?: string }) => {
      const r = await call<{ id?: string; sandbox_id?: string }>('POST', '/v1/sandboxes', { name: o.name, vcpu: o.vcpu, memory_mb: o.memoryMb, disk_gb: o.diskGb, region: o.region })
      const id = r.id ?? r.sandbox_id
      if (!id) throw new Error('Conway did not return a sandbox id')
      return id
    },
    exec: async (sandboxId: string, command: string, timeoutMs = 120_000) => {
      const r = await call<{ stdout?: string; stderr?: string; exit_code?: number; exitCode?: number }>('POST', `/v1/sandboxes/${sandboxId}/exec`, { command, timeout: timeoutMs })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exit_code ?? r.exitCode ?? -1 }
    },
    writeFile: (sandboxId: string, path: string, content: string) => call<void>('POST', `/v1/sandboxes/${sandboxId}/files/upload/json`, { path, content }),
  }
}
export type Conway = ReturnType<typeof conway>

/** Node runtime installed into nests, pinned by checksum (nodejs.org SHASUMS256.txt). */
export const NODE = {
  version: 'v22.23.3',
  sha256: {
    x64: 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de',
    arm64: 'a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f',
  },
} as const

/** A gremlin release bundle (built egg + runtime + production deps for linux), pinned by checksum. */
export interface Artifact {
  url: string
  sha256: string
}

const HEX64 = /^[0-9a-f]{64}$/
const SAFE_URL = /^https:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$/

/**
 * Shell script that installs pinned Node + the pinned bundle and starts the nest as a service.
 * The launch data (with the nest secret) is written separately via the files API, never into this script.
 */
export function nestBootstrapScript(artifact: Artifact): string {
  if (!HEX64.test(artifact.sha256)) throw new Error('artifact sha256 must be 64 lowercase hex chars')
  if (!SAFE_URL.test(artifact.url) || artifact.url.includes("'")) throw new Error('artifact url must be a plain https URL')
  return `set -eu
ARCH=$(uname -m); case "$ARCH" in x86_64) NA=x64; NS=${NODE.sha256.x64};; aarch64) NA=arm64; NS=${NODE.sha256.arm64};; *) echo "unsupported arch $ARCH"; exit 1;; esac
command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq curl ca-certificates xz-utils)
cd /tmp
curl -fsSL "https://nodejs.org/dist/${NODE.version}/node-${NODE.version}-linux-$NA.tar.xz" -o node.tar.xz
echo "$NS  node.tar.xz" | sha256sum -c -
mkdir -p /opt/node && tar -xJf node.tar.xz -C /opt/node --strip-components=1
curl -fsSL '${artifact.url}' -o gremlin.tgz
echo "${artifact.sha256}  gremlin.tgz" | sha256sum -c -
mkdir -p /opt/gremlin && tar -xzf gremlin.tgz -C /opt/gremlin
mkdir -p /var/lib/gremlin && chmod 700 /var/lib/gremlin
cat > /etc/gremlin.env <<ENV
GREMLIN_HOME=/var/lib/gremlin
GREMLIN_LAUNCH=/etc/gremlin/launch.json
PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
GREMLIN_RUNTIME=node /opt/gremlin/runtime/dist/index.js --gremlin-setup && exec node /opt/gremlin/runtime/dist/index.js --run
ENV
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/gremlin.service <<UNIT
[Unit]
Description=gremlin egg/nest
After=network-online.target
[Service]
EnvironmentFile=/etc/gremlin.env
ExecStart=/opt/node/bin/node /opt/gremlin/packages/egg/dist/main.js
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload && systemctl enable --now gremlin.service
else
  set -a; . /etc/gremlin.env; set +a
  nohup sh -c 'while true; do /opt/node/bin/node /opt/gremlin/packages/egg/dist/main.js; sleep 10; done' >> /var/log/gremlin.log 2>&1 &
  (crontab -l 2>/dev/null; echo "@reboot set -a; . /etc/gremlin.env; set +a; while true; do /opt/node/bin/node /opt/gremlin/packages/egg/dist/main.js; sleep 10; done >> /var/log/gremlin.log 2>&1") | crontab - || true
fi
echo gremlin-nest-started`
}
