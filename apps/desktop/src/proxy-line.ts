const decode = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** A proxy line pasted from a provider: `host:port`, `host:port:user:pass`, `user:pass@host:port`, optionally
 * with `http://`, `https://` or `socks5://` in front. Only fills the form fields; nothing is stored as a URL. */
export function parseProxyLine(line: string): Partial<{
  type: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username: string;
  password: string;
}> | null {
  let rest = line.trim();
  if (!rest) return null;
  let type: 'http' | 'https' | 'socks5' | undefined;
  const scheme = /^(https?|socks5h?):\/\//i.exec(rest);
  if (scheme) {
    const s = scheme[1]?.toLowerCase() ?? '';
    type = s.startsWith('socks') ? 'socks5' : (s as 'http' | 'https');
    rest = rest.slice(scheme[0].length);
  }
  rest = rest.replace(/\/+$/, '');
  let username: string | undefined;
  let password: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const cred = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const i = cred.indexOf(':');
    username = decode(i >= 0 ? cred.slice(0, i) : cred);
    password = i >= 0 ? decode(cred.slice(i + 1)) : '';
  }
  let host: string;
  let portText: string | undefined;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) return null;
    host = rest.slice(1, end);
    portText = rest.slice(end + 2) || undefined;
  } else {
    const parts = rest.split(':');
    host = parts[0] ?? '';
    portText = parts[1];
    if (parts.length >= 4 && username === undefined) {
      username = parts[2];
      password = parts.slice(3).join(':');
    }
  }
  const port = portText ? Number(portText) : undefined;
  if (!host || (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))) return null;
  return {
    ...(type ? { type } : {}),
    host,
    ...(port ? { port } : {}),
    ...(username !== undefined ? { username, password: password ?? '' } : {}),
  };
}
