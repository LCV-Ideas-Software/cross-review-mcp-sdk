const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /cfut_[A-Za-z0-9_-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /npm_[A-Za-z0-9]{30,}/g,
  /re_[A-Za-z0-9_]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /-----BEGIN (?:OPENSSH |EC |RSA |DSA |)PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |EC |RSA |DSA |)PRIVATE KEY-----/g,
  /[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
];

export function redact(value: string): string {
  let output = value;
  for (const re of SECRET_PATTERNS) output = output.replace(re, "[REDACTED]");
  return output;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redact(error.message);
  return redact(String(error));
}
