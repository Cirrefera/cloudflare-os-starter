import configurator from "@gadgets/scripts/gatekeeper-configurator";
export default {
  run: {
    tasks: {
      ...configurator.run.tasks,
      build: { dependsOn: ["build:configurator"], command: "tsc", cache: { input: [{ auto: true }, { pattern: "!dist/**", base: "package" }], output: ["dist/**"] } },
      test: { command: "vitest run", cache: { input: [{ auto: true }, { pattern: "!**/.wrangler/**", base: "workspace" }] } },
    },
  },
};
