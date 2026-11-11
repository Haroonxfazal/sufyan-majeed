import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default {
  ...defineCloudflareConfig(),
  // `npm run build` runs OpenNext, so OpenNext must call the plain Next.js build itself
  buildCommand: "npm run build:next",
};
