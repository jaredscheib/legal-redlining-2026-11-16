export function version(): string {
  const sha = process.env.GIT_SHA?.trim();
  return sha ? sha : "dev";
}
