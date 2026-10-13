#!/usr/bin/env node
// A stand-in for podman/docker in the bridge test: `image inspect … <image>`
// succeeds for the images listed in FAKE_IMAGES (comma-separated).
const args = process.argv.slice(2);
if (args[0] === "image" && args[1] === "inspect") {
  const image = args.at(-1);
  process.exit((process.env.FAKE_IMAGES ?? "").split(",").includes(image) ? 0 : 1);
}
console.error(`fake engine: unsupported ${args.join(" ")}`);
process.exit(2);
