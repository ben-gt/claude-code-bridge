// Best-effort secret scrubbing applied to every transcript line, log line and tool response.
// Exact-match values (the server token, credential-helper passwords) are registered at runtime
// via addSecret(); the regexes below catch the common shapes of tokens, keys and env files.

const exactSecrets = new Set();

export function addSecret(value) {
  if (typeof value === 'string' && value.length >= 6) exactSecrets.add(value);
}

const RULES = [
  // URLs with embedded userinfo: scheme://user:pass@host  (https, ssh, mongodb+srv, postgres, ...)
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\/\s@:"']+)(:[^\/\s@"']*)?@/g, (m, scheme, user, pass) => `${scheme}<redacted>@`],
  // Private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----'],
  // GitHub tokens
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '<redacted-github-token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<redacted-github-token>'],
  // Gitea / generic 40-hex tokens following token-ish words handled by env rule below.
  // Anthropic / OpenAI style keys
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '<redacted-api-key>'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '<redacted-api-key>'],
  // Slack
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '<redacted-slack-token>'],
  // AWS access key id
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted-aws-key>'],
  // Google API keys
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '<redacted-google-key>'],
  // Open WebUI style api_ tokens (as used by the other MCP servers on this box)
  [/\bapi_[A-Za-z0-9_-]{16,}\b/g, '<redacted-api-token>'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<redacted-jwt>'],
  // Authorization headers
  [/(Authorization\s*:\s*)(Bearer|Basic|Token|token)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1$2 <redacted>'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]{20,}/g, '$1 <redacted>'],
  // Secret-ish keys with QUOTED values (JSON / YAML / shell): keep the quoting so structure stays valid.
  [/((?:["']?)(?:[A-Za-z_][A-Za-z0-9_-]*)?(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credentials?|authorization|auth|private[_-]?key|signing[_-]?key|client[_-]?id|access[_-]?(?:id|key))(?:[A-Za-z0-9_-]*)(?:["']?)\s*[=:]\s*)(["'])(?!<redacted)[^"'\n]+\2/gi, '$1$2<redacted>$2'],
  // Secret-ish keys with UNQUOTED values at line start (env files, `export X=...`, YAML `X: value`).
  [/^(\s*(?:export\s+)?)((?:[A-Za-z_][A-Za-z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH|PRIVATE|SIGNING|CLIENT_ID|ACCESS_ID)[A-Za-z0-9_]*)(\s*[=:]\s*)(?!<redacted)(?!["'])\S.*$/gim, '$1$2$3<redacted>'],
  // Same keys assigned mid-line (container logs love `starting with API_KEY=...`). Uppercase keys, `=` only.
  [/\b((?:[A-Z_][A-Z0-9_]*)?(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH|PRIVATE|SIGNING|CLIENT_ID|ACCESS_ID)[A-Z0-9_]*=)(?!<redacted)(?!["'])\S+/g, '$1<redacted>'],
  // CLI flags --token=xxx / --password xxx
  [/(--?(?:token|password|passwd|secret|api-?key|access-?key)[= ]+)(?!<redacted)["']?[^\s"']{4,}["']?/gi, '$1<redacted>'],
];

export function scrub(text) {
  if (text === null || text === undefined) return text;
  let s = typeof text === 'string' ? text : String(text);
  for (const v of exactSecrets) {
    if (s.includes(v)) s = s.split(v).join('<redacted>');
  }
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s;
}

/** Scrub a URL specifically: drop userinfo, keep everything else. */
export function scrubUrl(url) {
  if (typeof url !== 'string') return url;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
      const u = new URL(url);
      u.username = '';
      u.password = '';
      return u.toString();
    }
  } catch { /* fall through */ }
  return scrub(url);
}

/** Deep-scrub strings in a JSON-able value. */
export function scrubDeep(value) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}
