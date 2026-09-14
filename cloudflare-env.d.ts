declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    GITHUB_ACTIONS_TOKEN?: string;
    CONVERSION_ACCESS_KEY?: string;
  }
}
