export default {
  run: {
    tasks: {
      build: { command: "tsc", cache: { input: [{ auto: true }, { pattern: "!dist/**", base: "package" }], output: ["dist/**"] } },
      test: { command: "vitest run", cache: { input: [{ auto: true }, { pattern: "!**/.wrangler/**", base: "workspace" }] } },
    },
  },
};
